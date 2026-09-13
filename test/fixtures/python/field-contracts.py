from urllib.parse import parse_qs as read_query


class Local:
    def get(self, key, default=None):
        return default


class Query:
    def __init__(self, value=None):
        if value is None:
            self.data = {}
        else:
            self.data = read_query(value)

    def query(self):
        return self.data.get("key")


class Comprehension:
    def __init__(self):
        self.data = {str(key): key for key in range(2)}

    def comprehension(self):
        return self.data.get("key")


class Positive:
    def __init__(self):
        self.data = Local()

    def positive(self):
        return self.data.get("key")


class Replaced:
    def __init__(self):
        self.data = {}

    def replace(self, value):
        self.data = value

    def replaced(self):
        return self.data.get("key")


class Shadow:
    def __init__(self, read_query):
        self.data = read_query("")

    def shadow(self):
        return self.data.get("key")
