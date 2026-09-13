import codecs
from codecs import getincrementaldecoder as decoder_factory


class Local:
    def decode(self, data=b"", final=False):
        return "local"


class ExternalField:
    def __init__(self, encoding):
        self.decoder = codecs.getincrementaldecoder(encoding)(errors="replace")

    def read(self):
        return self.decoder.decode(b"", True)


class AliasedField:
    def __init__(self, encoding):
        self.decoder = decoder_factory(encoding)()

    def read(self):
        return self.decoder.decode(b"")


class ReplacedField:
    def __init__(self, encoding, replacement):
        self.decoder = decoder_factory(encoding)()
        self.decoder = replacement

    def read(self):
        return self.decoder.decode(b"")


class ShadowedField:
    def __init__(self, codecs):
        self.decoder = codecs.getincrementaldecoder("utf-8")()

    def read(self):
        return self.decoder.decode(b"")


def positive(value: Local):
    return value.decode(b"")


def unresolved(value):
    return value.decode(b"")


def register_local(name):
    if name == "ucn_local":
        return codecs.CodecInfo(
            name="ucn_local",
            encode=lambda value, errors="strict": (b"", len(value)),
            decode=lambda value, errors="strict": ("local", len(value)),
            incrementaldecoder=lambda errors="strict": Local(),
        )
    return None


if __name__ == "__main__":
    codecs.register(register_local)
    try:
        # An external registry can return a project value without subclassing
        # codecs.IncrementalDecoder. Neither registry source nor its name is
        # evidence to exclude Local.decode.
        assert ExternalField("ucn-local").read() == "local"
        assert AliasedField("ucn-local").read() == "local"
        assert ReplacedField("utf-8", Local()).read() == "local"
        assert positive(Local()) == "local"
    finally:
        codecs.unregister(register_local)
