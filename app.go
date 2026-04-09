package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// App struct
type App struct {
	ctx      context.Context
	dataPath string
	mu       sync.Mutex
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
	a.dataPath = filepath.Join(configDir, "getman", "workspace.json")
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

	if a.dataPath == "" {
		return defaultWorkspace(), nil
	}

	contents, err := os.ReadFile(a.dataPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return defaultWorkspace(), nil
		}
		return Workspace{}, err
	}

	var workspace Workspace
	if err := json.Unmarshal(contents, &workspace); err != nil {
		return defaultWorkspace(), nil
	}

	return normalizeWorkspace(workspace), nil
}

func (a *App) SaveWorkspace(workspace Workspace) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.dataPath == "" {
		return errors.New("workspace path is not initialized")
	}

	workspace = normalizeWorkspace(workspace)
	workspace.UpdatedAt = time.Now().Format(time.RFC3339)

	parentDir := filepath.Dir(a.dataPath)
	if err := os.MkdirAll(parentDir, 0o755); err != nil {
		return err
	}

	payload, err := json.MarshalIndent(workspace, "", "  ")
	if err != nil {
		return err
	}

	tmpPath := a.dataPath + ".tmp"
	if err := os.WriteFile(tmpPath, payload, 0o644); err != nil {
		return err
	}

	return os.Rename(tmpPath, a.dataPath)
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

func defaultWorkspace() Workspace {
	return Workspace{
		Collections: []Collection{},
		UpdatedAt:   time.Now().Format(time.RFC3339),
	}
}
