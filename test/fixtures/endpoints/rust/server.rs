// Actix-style routes
use actix_web::{get, post, put, delete};

#[get("/users")]
async fn list_users() -> &'static str { "[]" }

#[post("/users")]
async fn create_user() -> &'static str { "{}" }

#[get("/users/{id}")]
async fn get_user() -> &'static str { "{}" }

#[delete("/users/{id}")]
async fn remove_user() -> &'static str { "{}" }
