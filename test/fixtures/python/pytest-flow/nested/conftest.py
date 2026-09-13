from pytest import fixture as supply
from model import Other


@supply
def client() -> Other:
    return Other()
