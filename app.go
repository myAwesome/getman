package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// App struct
type App struct {
	ctx        context.Context
	dataDir    string
	dbPath     string
	legacyPath string
	db         *sql.DB
	mu         sync.Mutex
	initErr    error
}

type Header struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type APIRequest struct {
	Method         string   `json:"method"`
	URL            string   `json:"url"`
	Headers        []Header `json:"headers"`
	Body           string   `json:"body"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
}

type APIResponse struct {
	Status     int      `json:"status"`
	StatusText string   `json:"statusText"`
	DurationMs int64    `json:"durationMs"`
	Headers    []Header `json:"headers"`
	Body       string   `json:"body"`
}

type SavedRequest struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Method  string   `json:"method"`
	URL     string   `json:"url"`
	Headers []Header `json:"headers"`
	Body    string   `json:"body"`
}

type Folder struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Requests []SavedRequest `json:"requests"`
}

type Collection struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Requests []SavedRequest `json:"requests"`
	Folders  []Folder       `json:"folders"`
}

type Workspace struct {
	Collections []Collection `json:"collections"`
	UpdatedAt   string       `json:"updatedAt"`
}

type CreateRequestInput struct {
	CollectionID string   `json:"collectionId"`
	FolderID     string   `json:"folderId"`
	Name         string   `json:"name"`
	Method       string   `json:"method"`
	URL          string   `json:"url"`
	Headers      []Header `json:"headers"`
	Body         string   `json:"body"`
}

type UpdateRequestInput struct {
	ID           string   `json:"id"`
	CollectionID string   `json:"collectionId"`
	FolderID     string   `json:"folderId"`
	Name         string   `json:"name"`
	Method       string   `json:"method"`
	URL          string   `json:"url"`
	Headers      []Header `json:"headers"`
	Body         string   `json:"body"`
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	configDir, err := os.UserConfigDir()
	if err != nil || configDir == "" {
		configDir = "."
	}

	a.dataDir = filepath.Join(configDir, "getman")
	a.dbPath = filepath.Join(a.dataDir, "workspace.db")
	a.legacyPath = filepath.Join(a.dataDir, "workspace.json")
	a.initErr = a.initStorage()
}

func (a *App) initStorage() error {
	if err := os.MkdirAll(a.dataDir, 0o755); err != nil {
		return err
	}

	db, err := sql.Open("sqlite", a.dbPath)
	if err != nil {
		return err
	}

	if _, err := db.Exec("PRAGMA foreign_keys = ON;"); err != nil {
		db.Close()
		return err
	}

	schema := `
CREATE TABLE IF NOT EXISTS collections (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	position INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
	id TEXT PRIMARY KEY,
	collection_id TEXT NOT NULL,
	name TEXT NOT NULL,
	position INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS requests (
	id TEXT PRIMARY KEY,
	collection_id TEXT NOT NULL,
	folder_id TEXT,
	name TEXT NOT NULL,
	method TEXT NOT NULL,
	url TEXT NOT NULL,
	headers_json TEXT NOT NULL,
	body TEXT NOT NULL,
	position INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
	FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_folders_collection_position ON folders(collection_id, position);
CREATE INDEX IF NOT EXISTS idx_requests_scope_position ON requests(collection_id, folder_id, position);
`

	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return err
	}

	a.db = db
	return a.migrateLegacyJSONIfNeeded()
}

func (a *App) migrateLegacyJSONIfNeeded() error {
	if a.legacyPath == "" {
		return nil
	}

	contents, err := os.ReadFile(a.legacyPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}

	var count int
	if err := a.db.QueryRow("SELECT COUNT(*) FROM collections").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	var workspace Workspace
	if err := json.Unmarshal(contents, &workspace); err != nil {
		return nil
	}

	workspace = normalizeWorkspace(workspace)
	if len(workspace.Collections) == 0 {
		return nil
	}

	return a.replaceWorkspace(workspace)
}

func (a *App) ensureDB() error {
	if a.initErr != nil {
		return a.initErr
	}
	if a.db == nil {
		return errors.New("storage not initialized")
	}
	return nil
}

func (a *App) SendRequest(payload APIRequest) (APIResponse, error) {
	method := strings.ToUpper(strings.TrimSpace(payload.Method))
	if method == "" {
		method = http.MethodGet
	}

	rawURL := strings.TrimSpace(payload.URL)
	if rawURL == "" {
		return APIResponse{}, errors.New("url is required")
	}

	parsedURL, err := url.ParseRequestURI(rawURL)
	if err != nil {
		return APIResponse{}, errors.New("url is invalid")
	}
	if parsedURL.Scheme == "" || parsedURL.Host == "" {
		return APIResponse{}, errors.New("url must include scheme and host")
	}

	var bodyReader io.Reader
	if payload.Body != "" {
		bodyReader = strings.NewReader(payload.Body)
	}

	req, err := http.NewRequest(method, rawURL, bodyReader)
	if err != nil {
		return APIResponse{}, err
	}

	for _, header := range payload.Headers {
		key := strings.TrimSpace(header.Key)
		if key == "" {
			continue
		}
		req.Header.Set(key, header.Value)
	}

	timeoutSeconds := payload.TimeoutSeconds
	if timeoutSeconds <= 0 {
		timeoutSeconds = 30
	}

	client := &http.Client{Timeout: time.Duration(timeoutSeconds) * time.Second}

	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return APIResponse{}, err
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return APIResponse{}, err
	}

	responseHeaders := make([]Header, 0, len(resp.Header))
	for key, values := range resp.Header {
		responseHeaders = append(responseHeaders, Header{
			Key:   key,
			Value: strings.Join(values, ", "),
		})
	}

	return APIResponse{
		Status:     resp.StatusCode,
		StatusText: resp.Status,
		DurationMs: time.Since(start).Milliseconds(),
		Headers:    responseHeaders,
		Body:       string(responseBody),
	}, nil
}

func (a *App) LoadWorkspace() (Workspace, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if err := a.ensureDB(); err != nil {
		return Workspace{}, err
	}

	workspace, err := a.loadWorkspaceFromDB()
	if err != nil {
		return Workspace{}, err
	}

	return normalizeWorkspace(workspace), nil
}

func (a *App) SaveWorkspace(workspace Workspace) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if err := a.ensureDB(); err != nil {
		return err
	}

	workspace = normalizeWorkspace(workspace)
	workspace.UpdatedAt = time.Now().Format(time.RFC3339)

	return a.replaceWorkspace(workspace)
}

func (a *App) CreateCollection(name string) (Collection, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if err := a.ensureDB(); err != nil {
		return Collection{}, err
	}

	name = strings.TrimSpace(name)
	if name == "" {
		name = "New Collection"
	}

	position, err := a.nextCollectionPosition(nil)
	if err != nil {
		return Collection{}, err
	}

	now := time.Now().Format(time.RFC3339)
	id := newID("col")
	_, err = a.db.Exec(
		`INSERT INTO collections (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		id,
		name,
		position,
		now,
		now,
	)
	if err != nil {
		return Collection{}, err
	}

	return Collection{ID: id, Name: name, Requests: []SavedRequest{}, Folders: []Folder{}}, nil
}

func (a *App) UpdateCollection(id string, name string) (Collection, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if err := a.ensureDB(); err != nil {
		return Collection{}, err
	}

	id = strings.TrimSpace(id)
	if id == "" {
		return Collection{}, errors.New("collection id is required")
	}

	name = strings.TrimSpace(name)
	if name == "" {
		name = "Collection"
	}

	result, err := a.db.Exec(
		`UPDATE collections SET name = ?, updated_at = ? WHERE id = ?`,
		name,
		time.Now().Format(time.RFC3339),
		id,
	)
	if err != nil {
		return Collection{}, err
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return Collection{}, err
	}
	if rows == 0 {
		return Collection{}, errors.New("collection not found")
	}

	return Collection{ID: id, Name: name, Requests: []SavedRequest{}, Folders: []Folder{}}, nil
}

func (a *App) DeleteCollection(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if err := a.ensureDB(); err != nil {
		return err
	}

	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("collection id is required")
	}

	result, err := a.db.Exec(`DELETE FROM collections WHERE id = ?`, id)
	if err != nil {
		return err
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return errors.New("collection not found")
	}

	return nil
}

func (a *App) CreateFolder(collectionID string, name string) (Folder, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if err := a.ensureDB(); err != nil {
		return Folder{}, err
	}

	collectionID = strings.TrimSpace(collectionID)
	if collectionID == "" {
		return Folder{}, errors.New("collection id is required")
	}
	if err := a.ensureCollectionExists(collectionID, nil); err != nil {
		return Folder{}, err
	}

	name = strings.TrimSpace(name)
	if name == "" {
		name = "New Folder"
	}

	position, err := a.nextFolderPosition(collectionID, nil)
	if err != nil {
		return Folder{}, err
	}

	now := time.Now().Format(time.RFC3339)
	id := newID("fld")
	_, err = a.db.Exec(
		`INSERT INTO folders (id, collection_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		id,
		collectionID,
		name,
		position,
		now,
		now,
	)
	if err != nil {
		return Folder{}, err
	}

	return Folder{ID: id, Name: name, Requests: []SavedRequest{}}, nil
}

func (a *App) UpdateFolder(id string, name string) (Folder, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if err := a.ensureDB(); err != nil {
		return Folder{}, err
	}

	id = strings.TrimSpace(id)
	if id == "" {
		return Folder{}, errors.New("folder id is required")
	}

	name = strings.TrimSpace(name)
	if name == "" {
		name = "Folder"
	}

	result, err := a.db.Exec(
		`UPDATE folders SET name = ?, updated_at = ? WHERE id = ?`,
		name,
		time.Now().Format(time.RFC3339),
		id,
	)
	if err != nil {
		return Folder{}, err
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return Folder{}, err
	}
	if rows == 0 {
		return Folder{}, errors.New("folder not found")
	}

	return Folder{ID: id, Name: name, Requests: []SavedRequest{}}, nil
}

func (a *App) DeleteFolder(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if err := a.ensureDB(); err != nil {
		return err
	}

	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("folder id is required")
	}

	result, err := a.db.Exec(`DELETE FROM folders WHERE id = ?`, id)
	if err != nil {
		return err
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return errors.New("folder not found")
	}

	return nil
}

func (a *App) CreateRequest(input CreateRequestInput) (SavedRequest, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if err := a.ensureDB(); err != nil {
		return SavedRequest{}, err
	}

	input.CollectionID = strings.TrimSpace(input.CollectionID)
	input.FolderID = strings.TrimSpace(input.FolderID)
	if input.CollectionID == "" {
		return SavedRequest{}, errors.New("collection id is required")
	}
	if err := a.ensureCollectionExists(input.CollectionID, nil); err != nil {
		return SavedRequest{}, err
	}
	if input.FolderID != "" {
		if err := a.ensureFolderInCollection(input.FolderID, input.CollectionID, nil); err != nil {
			return SavedRequest{}, err
		}
	}

	saved := SavedRequest{
		ID:      newID("req"),
		Name:    strings.TrimSpace(input.Name),
		Method:  normalizeMethod(input.Method),
		URL:     strings.TrimSpace(input.URL),
		Headers: normalizeHeaders(input.Headers),
		Body:    input.Body,
	}
	if saved.Name == "" {
		saved.Name = "New Request"
	}

	position, err := a.nextRequestPosition(input.CollectionID, input.FolderID, nil)
	if err != nil {
		return SavedRequest{}, err
	}

	headersJSON, err := json.Marshal(saved.Headers)
	if err != nil {
		return SavedRequest{}, err
	}

	now := time.Now().Format(time.RFC3339)
	_, err = a.db.Exec(
		`INSERT INTO requests (id, collection_id, folder_id, name, method, url, headers_json, body, position, created_at, updated_at)
		 VALUES (?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, ?, ?, ?)`,
		saved.ID,
		input.CollectionID,
		input.FolderID,
		saved.Name,
		saved.Method,
		saved.URL,
		string(headersJSON),
		saved.Body,
		position,
		now,
		now,
	)
	if err != nil {
		return SavedRequest{}, err
	}

	return saved, nil
}

func (a *App) UpdateRequest(input UpdateRequestInput) (SavedRequest, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if err := a.ensureDB(); err != nil {
		return SavedRequest{}, err
	}

	input.ID = strings.TrimSpace(input.ID)
	if input.ID == "" {
		return SavedRequest{}, errors.New("request id is required")
	}

	var currentCollectionID string
	var currentFolderID sql.NullString
	var currentPosition int
	if err := a.db.QueryRow(`SELECT collection_id, folder_id, position FROM requests WHERE id = ?`, input.ID).Scan(&currentCollectionID, &currentFolderID, &currentPosition); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SavedRequest{}, errors.New("request not found")
		}
		return SavedRequest{}, err
	}

	targetCollectionID := strings.TrimSpace(input.CollectionID)
	if targetCollectionID == "" {
		targetCollectionID = currentCollectionID
	}
	targetFolderID := strings.TrimSpace(input.FolderID)
	if input.FolderID == "" && currentFolderID.Valid {
		targetFolderID = currentFolderID.String
	}

	if err := a.ensureCollectionExists(targetCollectionID, nil); err != nil {
		return SavedRequest{}, err
	}
	if targetFolderID != "" {
		if err := a.ensureFolderInCollection(targetFolderID, targetCollectionID, nil); err != nil {
			return SavedRequest{}, err
		}
	}

	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = "Untitled Request"
	}
	method := normalizeMethod(input.Method)
	headers := normalizeHeaders(input.Headers)
	headersJSON, err := json.Marshal(headers)
	if err != nil {
		return SavedRequest{}, err
	}

	position := currentPosition
	oldFolderID := ""
	if currentFolderID.Valid {
		oldFolderID = currentFolderID.String
	}
	if oldFolderID != targetFolderID || currentCollectionID != targetCollectionID {
		position, err = a.nextRequestPosition(targetCollectionID, targetFolderID, nil)
		if err != nil {
			return SavedRequest{}, err
		}
	}

	_, err = a.db.Exec(
		`UPDATE requests
		 SET collection_id = ?, folder_id = NULLIF(?, ''), name = ?, method = ?, url = ?, headers_json = ?, body = ?, position = ?, updated_at = ?
		 WHERE id = ?`,
		targetCollectionID,
		targetFolderID,
		name,
		method,
		strings.TrimSpace(input.URL),
		string(headersJSON),
		input.Body,
		position,
		time.Now().Format(time.RFC3339),
		input.ID,
	)
	if err != nil {
		return SavedRequest{}, err
	}

	return SavedRequest{
		ID:      input.ID,
		Name:    name,
		Method:  method,
		URL:     strings.TrimSpace(input.URL),
		Headers: headers,
		Body:    input.Body,
	}, nil
}

func (a *App) DeleteRequest(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if err := a.ensureDB(); err != nil {
		return err
	}

	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("request id is required")
	}

	result, err := a.db.Exec(`DELETE FROM requests WHERE id = ?`, id)
	if err != nil {
		return err
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return errors.New("request not found")
	}

	return nil
}

func (a *App) loadWorkspaceFromDB() (Workspace, error) {
	collectionsRows, err := a.db.Query(`SELECT id, name FROM collections ORDER BY position ASC`)
	if err != nil {
		return Workspace{}, err
	}
	defer collectionsRows.Close()

	collections := []Collection{}
	for collectionsRows.Next() {
		var collection Collection
		if err := collectionsRows.Scan(&collection.ID, &collection.Name); err != nil {
			return Workspace{}, err
		}

		collection.Requests, err = a.loadRequests(collection.ID, "")
		if err != nil {
			return Workspace{}, err
		}

		folderRows, err := a.db.Query(`SELECT id, name FROM folders WHERE collection_id = ? ORDER BY position ASC`, collection.ID)
		if err != nil {
			return Workspace{}, err
		}

		collection.Folders = []Folder{}
		for folderRows.Next() {
			var folder Folder
			if err := folderRows.Scan(&folder.ID, &folder.Name); err != nil {
				folderRows.Close()
				return Workspace{}, err
			}
			folder.Requests, err = a.loadRequests(collection.ID, folder.ID)
			if err != nil {
				folderRows.Close()
				return Workspace{}, err
			}
			collection.Folders = append(collection.Folders, folder)
		}
		if err := folderRows.Err(); err != nil {
			folderRows.Close()
			return Workspace{}, err
		}
		folderRows.Close()

		collections = append(collections, collection)
	}
	if err := collectionsRows.Err(); err != nil {
		return Workspace{}, err
	}

	return Workspace{
		Collections: collections,
		UpdatedAt:   time.Now().Format(time.RFC3339),
	}, nil
}

func (a *App) loadRequests(collectionID string, folderID string) ([]SavedRequest, error) {
	var rows *sql.Rows
	var err error
	if folderID == "" {
		rows, err = a.db.Query(
			`SELECT id, name, method, url, headers_json, body FROM requests WHERE collection_id = ? AND folder_id IS NULL ORDER BY position ASC`,
			collectionID,
		)
	} else {
		rows, err = a.db.Query(
			`SELECT id, name, method, url, headers_json, body FROM requests WHERE collection_id = ? AND folder_id = ? ORDER BY position ASC`,
			collectionID,
			folderID,
		)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	requests := []SavedRequest{}
	for rows.Next() {
		var req SavedRequest
		var headersJSON string
		if err := rows.Scan(&req.ID, &req.Name, &req.Method, &req.URL, &headersJSON, &req.Body); err != nil {
			return nil, err
		}

		req.Headers = []Header{}
		if strings.TrimSpace(headersJSON) != "" {
			if err := json.Unmarshal([]byte(headersJSON), &req.Headers); err != nil {
				req.Headers = []Header{}
			}
		}

		requests = append(requests, req)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return requests, nil
}

func (a *App) replaceWorkspace(workspace Workspace) error {
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}

	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if _, err = tx.Exec(`DELETE FROM requests`); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM folders`); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM collections`); err != nil {
		return err
	}

	now := time.Now().Format(time.RFC3339)
	for ci, collection := range workspace.Collections {
		collectionID := strings.TrimSpace(collection.ID)
		if collectionID == "" {
			collectionID = newID("col")
		}
		collectionName := strings.TrimSpace(collection.Name)
		if collectionName == "" {
			collectionName = "Collection"
		}

		if _, err = tx.Exec(
			`INSERT INTO collections (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
			collectionID,
			collectionName,
			ci,
			now,
			now,
		); err != nil {
			return err
		}

		for ri, req := range collection.Requests {
			if err := insertRequestTx(tx, req, collectionID, "", ri, now); err != nil {
				return err
			}
		}

		for fi, folder := range collection.Folders {
			folderID := strings.TrimSpace(folder.ID)
			if folderID == "" {
				folderID = newID("fld")
			}
			folderName := strings.TrimSpace(folder.Name)
			if folderName == "" {
				folderName = "Folder"
			}

			if _, err = tx.Exec(
				`INSERT INTO folders (id, collection_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
				folderID,
				collectionID,
				folderName,
				fi,
				now,
				now,
			); err != nil {
				return err
			}

			for ri, req := range folder.Requests {
				if err := insertRequestTx(tx, req, collectionID, folderID, ri, now); err != nil {
					return err
				}
			}
		}
	}

	if err = tx.Commit(); err != nil {
		return err
	}
	return nil
}

func insertRequestTx(tx *sql.Tx, request SavedRequest, collectionID string, folderID string, position int, now string) error {
	id := strings.TrimSpace(request.ID)
	if id == "" {
		id = newID("req")
	}

	name := strings.TrimSpace(request.Name)
	if name == "" {
		name = "Untitled Request"
	}

	headers := normalizeHeaders(request.Headers)
	headersJSON, err := json.Marshal(headers)
	if err != nil {
		return err
	}

	_, err = tx.Exec(
		`INSERT INTO requests (id, collection_id, folder_id, name, method, url, headers_json, body, position, created_at, updated_at)
		 VALUES (?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		collectionID,
		folderID,
		name,
		normalizeMethod(request.Method),
		strings.TrimSpace(request.URL),
		string(headersJSON),
		request.Body,
		position,
		now,
		now,
	)
	if err != nil {
		return err
	}

	return nil
}

func (a *App) ensureCollectionExists(collectionID string, tx *sql.Tx) error {
	var (
		count int
		err   error
	)
	if tx == nil {
		err = a.db.QueryRow(`SELECT COUNT(*) FROM collections WHERE id = ?`, collectionID).Scan(&count)
	} else {
		err = tx.QueryRow(`SELECT COUNT(*) FROM collections WHERE id = ?`, collectionID).Scan(&count)
	}
	if err != nil {
		return err
	}
	if count == 0 {
		return errors.New("collection not found")
	}
	return nil
}

func (a *App) ensureFolderInCollection(folderID string, collectionID string, tx *sql.Tx) error {
	var (
		existingCollectionID string
		err                  error
	)
	if tx == nil {
		err = a.db.QueryRow(`SELECT collection_id FROM folders WHERE id = ?`, folderID).Scan(&existingCollectionID)
	} else {
		err = tx.QueryRow(`SELECT collection_id FROM folders WHERE id = ?`, folderID).Scan(&existingCollectionID)
	}
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("folder not found")
		}
		return err
	}
	if existingCollectionID != collectionID {
		return errors.New("folder does not belong to collection")
	}
	return nil
}

func (a *App) nextCollectionPosition(tx *sql.Tx) (int, error) {
	return nextPosition(a.db, tx, `SELECT COALESCE(MAX(position), -1) + 1 FROM collections`)
}

func (a *App) nextFolderPosition(collectionID string, tx *sql.Tx) (int, error) {
	return nextPosition(a.db, tx, `SELECT COALESCE(MAX(position), -1) + 1 FROM folders WHERE collection_id = ?`, collectionID)
}

func (a *App) nextRequestPosition(collectionID string, folderID string, tx *sql.Tx) (int, error) {
	if folderID == "" {
		return nextPosition(a.db, tx, `SELECT COALESCE(MAX(position), -1) + 1 FROM requests WHERE collection_id = ? AND folder_id IS NULL`, collectionID)
	}
	return nextPosition(a.db, tx, `SELECT COALESCE(MAX(position), -1) + 1 FROM requests WHERE collection_id = ? AND folder_id = ?`, collectionID, folderID)
}

func nextPosition(db *sql.DB, tx *sql.Tx, query string, args ...any) (int, error) {
	var (
		position int
		err      error
	)
	if tx == nil {
		err = db.QueryRow(query, args...).Scan(&position)
	} else {
		err = tx.QueryRow(query, args...).Scan(&position)
	}
	return position, err
}

func normalizeWorkspace(workspace Workspace) Workspace {
	if workspace.Collections == nil {
		workspace.Collections = []Collection{}
	}

	for i := range workspace.Collections {
		if workspace.Collections[i].Requests == nil {
			workspace.Collections[i].Requests = []SavedRequest{}
		}
		if workspace.Collections[i].Folders == nil {
			workspace.Collections[i].Folders = []Folder{}
		}

		for j := range workspace.Collections[i].Folders {
			if workspace.Collections[i].Folders[j].Requests == nil {
				workspace.Collections[i].Folders[j].Requests = []SavedRequest{}
			}
		}
	}

	return workspace
}

func normalizeMethod(method string) string {
	method = strings.ToUpper(strings.TrimSpace(method))
	if method == "" {
		return http.MethodGet
	}
	return method
}

func normalizeHeaders(headers []Header) []Header {
	if len(headers) == 0 {
		return []Header{}
	}

	normalized := make([]Header, 0, len(headers))
	for _, h := range headers {
		key := strings.TrimSpace(h.Key)
		if key == "" {
			continue
		}
		normalized = append(normalized, Header{Key: key, Value: h.Value})
	}

	if normalized == nil {
		return []Header{}
	}
	return normalized
}

func newID(prefix string) string {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return fmt.Sprintf("%s_%d_%s", prefix, time.Now().UnixNano(), hex.EncodeToString(buf))
}

func defaultWorkspace() Workspace {
	return Workspace{
		Collections: []Collection{},
		UpdatedAt:   time.Now().Format(time.RFC3339),
	}
}
