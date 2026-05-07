import javax.ws.rs.*;

@Path("/items")
public class JaxRsResource {

    @GET
    public String getAll() { return "[]"; }

    @POST
    @Path("/new")
    public String create() { return "{}"; }

    @DELETE
    @Path("/{id}")
    public String remove() { return "{}"; }
}
