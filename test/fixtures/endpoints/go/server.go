package main

import (
	"net/http"
)

func main() {
	http.HandleFunc("/users", listUsers)
	http.HandleFunc("/users/create", createUser)
	http.ListenAndServe(":8080", nil)
}

func setupGin(r Engine) {
	r.GET("/api/items", listItems)
	r.POST("/api/items", createItem)
	r.PUT("/api/items/:id", updateItem)
}

type Engine interface {
	GET(path string, h func())
	POST(path string, h func())
	PUT(path string, h func())
}

func listUsers()  {}
func createUser() {}
func listItems()  {}
func createItem() {}
func updateItem() {}
