import pytest
from model import Local, Other


def test_direct(client):
    assert client.ping() == "local"


def test_property(server):
    assert server.url.netloc.decode() == "localhost"


def ordinary(client):
    return client.ping()


def test_replaced(client):
    client = unknown()
    assert client.ping() == "other"


@pytest.mark.parametrize("client", [Other()])
def test_parametrized(client):
    assert client.ping() == "other"


def unknown():
    return Other()


def unknown_fixture(client):
    return client.ping()
