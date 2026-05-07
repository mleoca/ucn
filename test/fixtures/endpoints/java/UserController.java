import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {

    @GetMapping
    public List<User> findAll() { return null; }

    @GetMapping("/{id}")
    public User findOne(@PathVariable Long id) { return null; }

    @PostMapping
    public User create(@RequestBody User user) { return user; }

    @PutMapping("/{id}")
    public User update(@PathVariable Long id, @RequestBody User user) { return user; }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable Long id) {}
}

class User {}
class List<T> {}
