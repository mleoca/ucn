def test_override(client):
    assert client.ping() == "other"
