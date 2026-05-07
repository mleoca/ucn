// reqwest client
async fn fetch_users() -> Result<String, reqwest::Error> {
    let client = reqwest::Client::new();
    client.get("/users").send().await?.text().await
}

async fn get_user(id: u64) -> Result<String, reqwest::Error> {
    let client = reqwest::Client::new();
    let url = format!("/users/{}", id);
    client.get(&url).send().await?.text().await
}

async fn create_user() -> Result<String, reqwest::Error> {
    let client = reqwest::Client::new();
    client.post("/users").send().await?.text().await
}
