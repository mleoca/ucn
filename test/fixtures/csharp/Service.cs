public interface IService
{
    int Run(int value);
}

public sealed class Service : IService
{
    public int Run(int value)
    {
        return Helper(value);
    }

    private static int Helper(int value)
    {
        return value + 1;
    }
}
