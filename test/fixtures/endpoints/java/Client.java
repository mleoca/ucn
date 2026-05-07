public class Client {
    private RestTemplate restTemplate = new RestTemplate();

    public Object listUsers() {
        return restTemplate.getForObject("/api/users", Object.class);
    }

    public Object createUser(Object data) {
        return restTemplate.postForObject("/api/users", data, Object.class);
    }
}

class RestTemplate {
    public <T> T getForObject(String url, Class<T> type) { return null; }
    public <T> T postForObject(String url, Object req, Class<T> type) { return null; }
}
