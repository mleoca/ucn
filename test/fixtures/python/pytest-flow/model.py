class Local:
    def ping(self):
        return "local"

    def decode(self):
        return "local"


class Other:
    def ping(self):
        return "other"


class Address:
    @property
    def netloc(self) -> bytes:
        return b"localhost"
