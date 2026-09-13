import pytest
from typing import Iterator
import model
from model import Local


class Server:
    @property
    def url(self) -> model.Address:
        return model.Address()


@pytest.fixture
def client() -> Local:
    return Local()


@pytest.fixture(name="server")
def make_server() -> Iterator[Server]:
    yield Server()
