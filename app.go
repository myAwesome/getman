package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// App struct
type App struct {
	ctx context.Context
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

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
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
