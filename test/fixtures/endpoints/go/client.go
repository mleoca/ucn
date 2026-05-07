package main

import (
	"fmt"
	"net/http"
)

func fetchUsers() (*http.Response, error) {
	return http.Get("/users")
}

func getUser(id int) (*http.Response, error) {
	return http.Get(fmt.Sprintf("/users/%d", id))
}

func createUserRequest() (*http.Response, error) {
	return http.Post("/users", "application/json", nil)
}
