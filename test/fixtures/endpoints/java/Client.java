import org.springframework.web.client.RestTemplate;
public class Client {
    private RestTemplate restTemplate = new RestTemplate();

    public Object listUsers() {
        return restTemplate.getForObject("/api/users", Object.class);
    }

    public Object createUser(Object data) {
        return restTemplate.postForObject("/api/users", data, Object.class);
    }
}
