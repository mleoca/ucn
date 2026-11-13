/** Construction-result proofs (fix #498 review). These fixture shapes are
 * also executed by the runtime-judged review probes. Replacement cases reach
 * Other.save; preserving controls reach the declared method. Both graph directions must retain it and may
 * not confirm the method on the class being replaced. */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { tmp, rm, idx } = require('./helpers');
const { execute } = require('../core/execute');
const cases = [];
const other = `from tr import hit
class Other:
    def __init__(self, *args): pass
    def __call__(self, *args): return self
    def save(self): hit()
`;
const namesake = `from tr import hit
class User:
    def save(self): hit()
`;
function add(id, model, context = false, expectedOwner = 'Other', extraFiles = {}) {
  for (const qualified of [false, true]) {
    const spelling = qualified ? 'models.User' : 'User';
    const imports = qualified ? 'import models\n' : 'from models import User\n';
    const body = context ? `def chained():
    with ${spelling}() as value:
        value.save()

def variable():
    item = ${spelling}()
    with item as value:
        value.save()
` : `def chained():
    ${spelling}().save()

def variable():
    value = ${spelling}()
    value.save()
`;
    cases.push({id: id + (qualified ? '-qualified' : '-bare'), expectedOwner, lang: 'python', names: ['save'], files: {
      ...extraFiles, 'other.py': other, 'namesake.py': namesake,
      'helper.py': 'from other import Other\ndef change(value): value.__class__ = Other\ndef decorate(cls):\n    cls.save = Other.save\n    return cls\ndef keep(value): value.note = 1\n',
      'models.py': `from tr import hit\nfrom other import Other\n` + model,
      'views.py': imports + body,
      'main.py': 'from views import chained, variable\nchained()\nvariable()\n'
    }});
  }
}
add('decorator-parameter-rebound', `def decorate(cls):
    cls = Other
    return cls

@decorate
class User:
    def save(self): hit()
`);
add('decorator-function-rebound', `def keep(cls):
    return cls

def replace(cls):
    return Other

def decorate(cls):
    keep = replace
    return keep(cls)

@decorate
class User:
    def save(self): hit()
`);
add('decorator-call-factory-identity', `def choose(cls):
    return cls

@choose(Other)
class User:
    def save(self): hit()
`);
add('decorator-mutates-allocation', `def decorate(cls):
    cls.__new__ = staticmethod(lambda cls: Other())
    return cls

@decorate
class User:
    def save(self): hit()
`);
add('decorator-mutates-method', `def decorate(cls):
    cls.save = Other.save
    return cls

@decorate
class User:
    def save(self): hit()
`);
add('enter-parameter-rebound', `class User:
    def __enter__(self):
        self = Other()
        return self
    def __exit__(self, *args): pass
    def save(self): hit()
`, true);
add('enter-decorated-method', `def replace_enter(fn):
    def replacement(self):
        return Other()
    return replacement

class User:
    @replace_enter
    def __enter__(self):
        return self
    def __exit__(self, *args): pass
    def save(self): hit()
`, true);
add('custom-allocator', `class User:
    def __new__(cls):
        return Other()
    def save(self): hit()
`);
add('custom-metaclass', `class Meta(type):
    def __call__(cls, *args):
        return Other()

class User(metaclass=Meta):
    def save(self): hit()
`);
add('custom-replacing-decorator', `def replace(cls):
    return Other

@replace
class User:
    def save(self): hit()
`);
add('init-mutates-class', `class User:
    def __init__(self):
        self.__class__ = Other
    def save(self): hit()
`);
add('function-metaclass', `def make_class(name, bases, namespace):
    return Other

class User(metaclass=make_class):
    def save(self): hit()
`);
add('computed-base-allocator', `class Allocate:
    def __new__(cls):
        return Other()

def base():
    return Allocate

class User(base()):
    def save(self): hit()
`);
add('metaclass-creates-other-class', `class Meta(type):
    def __new__(mcls, name, bases, namespace):
        return Other

class User(metaclass=Meta):
    def save(self): hit()
`);
add('metaclass-mutates-method', `class Meta(type):
    def __init__(cls, name, bases, namespace):
        cls.save = Other.save

class User(metaclass=Meta):
    def save(self): hit()
`);
add('decorator-is-itself-decorated', `def replace_function(fn):
    def replacement(cls):
        return Other
    return replacement

@replace_function
def keep(cls):
    return cls

@keep
class User:
    def save(self): hit()
`);
add('static-enter-default-value', `class User:
    @staticmethod
    def __enter__(self=Other()):
        return self
    def __exit__(self, *args): pass
    def save(self): hit()
`,true);
add('aliased-function-metaclass', `def make_class(name, bases, namespace):
    return Other

Meta = make_class
class User(metaclass=Meta):
    def save(self): hit()
`);
add('init-setattr-class', `class User:
    def __init__(self):
        setattr(self, '__class__', Other)
    def save(self): hit()
`);


cases.push(...[
    {
        "id": "js-return-named",
        "lang": "esm",
        "names": [
            "save"
        ],
        "files": {
            "models.js": "import { hit } from './tr.js';\nexport class Other {\n  save() { hit(); }\n}\nexport class User {\n  constructor() { return new Other(); }\n  save() { hit(); }\n}\n",
            "main.js": "import { User } from './models.js';\nfunction main() {\n  new User().save();\n  const user = new User();\n  user.save();\n}\nmain();\n"
        }
    },
    {
        "id": "js-return-aliased",
        "lang": "esm",
        "names": [
            "save"
        ],
        "files": {
            "models.js": "import { hit } from './tr.js';\nexport class Other {\n  save() { hit(); }\n}\nexport class User {\n  constructor() { return new Other(); }\n  save() { hit(); }\n}\n",
            "main.js": "import { User as Alias } from './models.js';\nfunction main() {\n  new Alias().save();\n  const user = new Alias();\n  user.save();\n}\nmain();\n"
        }
    },
    {
        "id": "js-return-qualified",
        "lang": "esm",
        "names": [
            "save"
        ],
        "files": {
            "models.js": "import { hit } from './tr.js';\nexport class Other {\n  save() { hit(); }\n}\nexport class User {\n  constructor() { return new Other(); }\n  save() { hit(); }\n}\n",
            "main.js": "import * as models from './models.js';\nfunction main() {\n  new models.User().save();\n  const user = new models.User();\n  user.save();\n}\nmain();\n"
        }
    },
    {
        "id": "js-function-local-return",
        "lang": "esm",
        "names": [
            "save"
        ],
        "files": {
            "main.js": "import { hit } from './tr.js';\nclass Other {\n  save() { hit(); }\n}\nfunction main() {\n  class User {\n    constructor() { return new Other(); }\n    save() { hit(); }\n  }\n  new User().save();\n  const user = new User();\n  user.save();\n}\nmain();\n"
        }
    },
    {
        "id": "js-computed-base-return",
        "lang": "esm",
        "names": [
            "save"
        ],
        "files": {
            "main.js": "import { hit } from './tr.js';\nclass Other {\n  save() { hit(); }\n}\nclass Parent {\n  constructor() { return new Other(); }\n}\nfunction mixin() { return Parent; }\nclass User extends mixin() {\n  save() { hit(); }\n}\nfunction main() {\n  new User().save();\n  const user = new User();\n  user.save();\n}\nmain();\n"
        }
    },
    {
        "id": "cjs-namespace-member-rebound",
        "lang": "cjs",
        "names": [
            "save"
        ],
        "files": {
            "models.js": "const { hit } = require('./tr.js');\nclass User { save() { hit(); } }\nclass Other { save() { hit(); } }\nmodule.exports = { User, Other };\n",
            "main.js": "const models = require('./models.js');\nmodels.User = models.Other;\nfunction main() {\n  new models.User().save();\n  const u = new models.User();\n  u.save();\n}\nmain();\n"
        }
    },
    {
        "id": "py-namespace-member-rebound",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "models.py": "from tr import hit\nclass User:\n    def save(self): hit()\nclass Other:\n    def save(self): hit()\n",
            "main.py": "import models\nmodels.User = models.Other\ndef main():\n    models.User().save()\n    u = models.User()\n    u.save()\nmain()\n"
        }
    },
    {
        "id": "cjs-namespace-root-rebound",
        "lang": "cjs",
        "names": [
            "save"
        ],
        "files": {
            "models.js": "const { hit } = require('./tr.js');\nclass User { save() { hit(); } }\nclass Other { save() { hit(); } }\nmodule.exports = { User, Other };\n",
            "main.js": "let models = require('./models.js');\nconst original = models;\nmodels = {User: original.Other};\nfunction main() {\n  new models.User().save();\n  const u = new models.User();\n  u.save();\n}\nmain();\n"
        }
    },
    {
        "id": "py-namespace-root-rebound",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "models.py": "from tr import hit\nclass User:\n    def save(self): hit()\nclass Other:\n    def save(self): hit()\n",
            "main.py": "import models\nfrom types import SimpleNamespace\nmodels = SimpleNamespace(User=models.Other)\ndef main():\n    models.User().save()\n    u = models.User()\n    u.save()\nmain()\n"
        }
    }
]);

cases.push(...[
    {
        "id": "decorator-alias-mutates-method-bare",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef decorate(cls):\n    alias = cls\n    alias.save = Other.save\n    return cls\n\n@decorate\nclass User:\n    def save(self): hit()\n",
            "views.py": "from models import User\ndef chained():\n    User().save()\n\ndef variable():\n    value = User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "decorator-alias-mutates-method-qualified",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef decorate(cls):\n    alias = cls\n    alias.save = Other.save\n    return cls\n\n@decorate\nclass User:\n    def save(self): hit()\n",
            "views.py": "import models\ndef chained():\n    models.User().save()\n\ndef variable():\n    value = models.User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "decorator-conditional-helper-mutates-method-bare",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef mutate(cls):\n    cls.save = Other.save\n    return cls\n\ndef decorate(cls):\n    if True:\n        mutate(cls)\n    return cls\n\n@decorate\nclass User:\n    def save(self): hit()\n",
            "views.py": "from models import User\ndef chained():\n    User().save()\n\ndef variable():\n    value = User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "decorator-conditional-helper-mutates-method-qualified",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef mutate(cls):\n    cls.save = Other.save\n    return cls\n\ndef decorate(cls):\n    if True:\n        mutate(cls)\n    return cls\n\n@decorate\nclass User:\n    def save(self): hit()\n",
            "views.py": "import models\ndef chained():\n    models.User().save()\n\ndef variable():\n    value = models.User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "decorator-assigned-helper-mutates-method-bare",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef mutate(cls):\n    cls.save = Other.save\n    return cls\n\ndef decorate(cls):\n    ignored = mutate(cls)\n    return cls\n\n@decorate\nclass User:\n    def save(self): hit()\n",
            "views.py": "from models import User\ndef chained():\n    User().save()\n\ndef variable():\n    value = User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "decorator-assigned-helper-mutates-method-qualified",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef mutate(cls):\n    cls.save = Other.save\n    return cls\n\ndef decorate(cls):\n    ignored = mutate(cls)\n    return cls\n\n@decorate\nclass User:\n    def save(self): hit()\n",
            "views.py": "import models\ndef chained():\n    models.User().save()\n\ndef variable():\n    value = models.User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "decorator-factory-keyword-first-param-bare",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef decorate(cls=None):\n    if cls is None:\n        def keep(value):\n            return value\n        return keep\n    return cls\n\n@decorate(cls=Other)\nclass User:\n    def save(self): hit()\n",
            "views.py": "from models import User\ndef chained():\n    User().save()\n\ndef variable():\n    value = User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "decorator-factory-keyword-first-param-qualified",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef decorate(cls=None):\n    if cls is None:\n        def keep(value):\n            return value\n        return keep\n    return cls\n\n@decorate(cls=Other)\nclass User:\n    def save(self): hit()\n",
            "views.py": "import models\ndef chained():\n    models.User().save()\n\ndef variable():\n    value = models.User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "initializer-alias-changes-class-bare",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\nclass User:\n    def __init__(self):\n        alias = self\n        alias.__class__ = Other\n    def save(self): hit()\n",
            "views.py": "from models import User\ndef chained():\n    User().save()\n\ndef variable():\n    value = User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "initializer-alias-changes-class-qualified",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\nclass User:\n    def __init__(self):\n        alias = self\n        alias.__class__ = Other\n    def save(self): hit()\n",
            "views.py": "import models\ndef chained():\n    models.User().save()\n\ndef variable():\n    value = models.User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "initializer-helper-changes-class-bare",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef change_class(value):\n    value.__class__ = Other\n\nclass User:\n    def __init__(self):\n        change_class(self)\n    def save(self): hit()\n",
            "views.py": "from models import User\ndef chained():\n    User().save()\n\ndef variable():\n    value = User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "initializer-helper-changes-class-qualified",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef change_class(value):\n    value.__class__ = Other\n\nclass User:\n    def __init__(self):\n        change_class(self)\n    def save(self): hit()\n",
            "views.py": "import models\ndef chained():\n    models.User().save()\n\ndef variable():\n    value = models.User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "enter-changes-class-bare",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\nclass User:\n    def __enter__(self):\n        self.__class__ = Other\n        return self\n    def __exit__(self, *args): pass\n    def save(self): hit()\n",
            "views.py": "from models import User\ndef chained():\n    with User() as value:\n        value.save()\n\ndef variable():\n    item = User()\n    with item as value:\n        value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "enter-changes-class-qualified",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\nclass User:\n    def __enter__(self):\n        self.__class__ = Other\n        return self\n    def __exit__(self, *args): pass\n    def save(self): hit()\n",
            "views.py": "import models\ndef chained():\n    with models.User() as value:\n        value.save()\n\ndef variable():\n    item = models.User()\n    with item as value:\n        value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "decorator-local-import-shadows-helper-bare",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef keep(cls):\n    return cls\n\ndef decorate(cls):\n    from helper import replacement as keep\n    return keep(cls)\n\n@decorate\nclass User:\n    def save(self): hit()\n",
            "views.py": "from models import User\ndef chained():\n    User().save()\n\ndef variable():\n    value = User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n",
            "helper.py": "from other import Other\ndef replacement(cls):\n    return Other\n"
        }
    },
    {
        "id": "decorator-for-rebinds-parameter-bare",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef decorate(cls):\n    for cls in [Other]:\n        pass\n    return cls\n\n@decorate\nclass User:\n    def save(self): hit()\n",
            "views.py": "from models import User\ndef chained():\n    User().save()\n\ndef variable():\n    value = User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n",
            "helper.py": "from other import Other\ndef replacement(cls):\n    return Other\n"
        }
    },
    {
        "id": "decorator-local-import-shadows-helper-qualified",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef keep(cls):\n    return cls\n\ndef decorate(cls):\n    from helper import replacement as keep\n    return keep(cls)\n\n@decorate\nclass User:\n    def save(self): hit()\n",
            "views.py": "import models\ndef chained():\n    models.User().save()\n\ndef variable():\n    value = models.User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n",
            "helper.py": "from other import Other\ndef replacement(cls):\n    return Other\n"
        }
    },
    {
        "id": "decorator-for-rebinds-parameter-qualified",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef decorate(cls):\n    for cls in [Other]:\n        pass\n    return cls\n\n@decorate\nclass User:\n    def save(self): hit()\n",
            "views.py": "import models\ndef chained():\n    models.User().save()\n\ndef variable():\n    value = models.User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n",
            "helper.py": "from other import Other\ndef replacement(cls):\n    return Other\n"
        }
    },
    {
        "id": "cjs-subscript-write",
        "lang": "cjs",
        "names": [
            "save"
        ],
        "files": {
            "models.js": "const { hit } = require('./tr.js');\nclass User { save() { hit(); } }\nclass Other { save() { hit(); } }\nmodule.exports = { User, Other };\n",
            "main.js": "const models = require('./models.js');\nmodels['User'] = models.Other;\nfunction main() {\n  new models.User().save();\n  const u = new models.User();\n  u.save();\n}\nmain();\n"
        }
    },
    {
        "id": "cjs-escaped-subscript-write",
        "lang": "cjs",
        "names": [
            "save"
        ],
        "files": {
            "models.js": "const { hit } = require('./tr.js');\nclass User { save() { hit(); } }\nclass Other { save() { hit(); } }\nmodule.exports = { User, Other };\n",
            "main.js": "const models = require('./models.js');\nmodels['Us\\u0065r'] = models.Other;\nfunction main() {\n  new models.User().save();\n  const u = new models.User();\n  u.save();\n}\nmain();\n"
        }
    },
    {
        "id": "py-setattr-write",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "models.py": "from tr import hit\nclass User:\n    def save(self): hit()\nclass Other:\n    def save(self): hit()\n",
            "main.py": "import models\nsetattr(models, 'User', models.Other)\ndef main():\n    models.User().save()\n    u = models.User()\n    u.save()\nmain()\n"
        }
    },
    {
        "id": "unicode-decorator-false",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom other import Other\ndef déco(cls):\n    return Other\n\n@déco\nclass User:\n    def save(self): hit()\n",
            "views.py": "from models import User\ndef chained():\n    User().save()\n\ndef variable():\n    value = User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n"
        }
    },
    {
        "id": "unicode-decorator-true",
        "lang": "python",
        "names": [
            "save"
        ],
        "files": {
            "other.py": "from tr import hit\nclass Other:\n    def __init__(self, *args): pass\n    def __call__(self, *args): return self\n    def save(self): hit()\n",
            "namesake.py": "from tr import hit\nclass User:\n    def save(self): hit()\n",
            "models.py": "from tr import hit\nfrom deco import déco as 変換\n@変換\nclass User:\n    def save(self): hit()\n",
            "views.py": "from models import User\ndef chained():\n    User().save()\n\ndef variable():\n    value = User()\n    value.save()\n",
            "main.py": "from views import chained, variable\nchained()\nvariable()\n",
            "deco.py": "from other import Other\ndef déco(cls):\n    return Other\n"
        }
    }
]);

add('decorator-keyword-helper-mutates', `def mutate(cls):
    cls.save = Other.save
    return cls

def decorate(cls):
    mutate(cls=cls)
    return cls

@decorate
class User:
    def save(self): hit()
`);
add('initializer-keyword-helper-mutates', `def mutate(value):
    value.__class__ = Other

class User:
    def __init__(self):
        mutate(value=self)
    def save(self): hit()
`);
add('enter-keyword-helper-mutates', `def mutate(value):
    value.__class__ = Other

class User:
    def __enter__(self):
        mutate(value=self)
        return self
    def __exit__(self, *args): pass
    def save(self): hit()
`,true);
add('subscript-base-allocator', `class Allocator:
    def __new__(cls):
        return Other()

class Generic:
    def __class_getitem__(cls, key):
        return Allocator

class User(Generic[int]):
    def save(self): hit()
`);
add('computed-metaclass', `class Meta(type):
    def __call__(cls, *args):
        return Other()

def choose_meta():
    return Meta

class User(metaclass=choose_meta()):
    def save(self): hit()
`);
add('initializer-qualified-project-helper', `import helper
class User:
    def __init__(self):
        helper.change(self)
    def save(self): hit()
`);
add('decorator-qualified-project-helper', `import helper
def decorate(cls):
    helper.decorate(cls)
    return cls

@decorate
class User:
    def save(self): hit()
`);
add('initializer-spread-list-helper', `def mutate(value):
    value.__class__ = Other

class User:
    def __init__(self):
        mutate(*[self])
    def save(self): hit()
`);
add('initializer-spread-dict-helper', `def mutate(value):
    value.__class__ = Other

class User:
    def __init__(self):
        mutate(**{'value': self})
    def save(self): hit()
`);
add('decorator-spread-dict-helper', `def mutate(cls):
    cls.save = Other.save
    return cls

def decorate(cls):
    mutate(**{'cls': cls})
    return cls

@decorate
class User:
    def save(self): hit()
`);
add('initializer-helper-parameter-shadow', `def keep(value): pass
def replace(value): value.__class__ = Other
class User:
    def __init__(self, keep=replace): keep(self)
    def save(self): hit()
`);
add('initializer-duplicate-helper-last-wins', `class User:
    def change(self): pass
    def change(self): self.__class__ = Other
    def __init__(self): self.change()
    def save(self): hit()
`);
add('initializer-captured-identity', `class User:
    def __init__(self):
        def change(): self.__class__ = Other
        change()
    def save(self): hit()
`);
add('decorator-captured-identity', `def decorate(cls):
    def change(): cls.save = Other.save
    change()
    return cls
@decorate
class User:
    def save(self): hit()
`);
add('decorator-container-escape', `def decorate(cls):
    box = [cls]
    box[0].save = Other.save
    return cls
@decorate
class User:
    def save(self): hit()
`);
add('initializer-parenthesized-alias', `class User:
    def __init__(self):
        alias = (self)
        alias.__class__ = Other
    def save(self): hit()
`);
add('initializer-qualified-keeping-helper-control', `import helper
class User:
    def __init__(self): helper.keep(value=(self))
    def save(self): hit()
`,false,'User');
add('decorator-keyword-keeping-helper-control', `def keep(value):
    value.note = 1
    return value
def decorate(cls):
    keep(value=(cls))
    return cls
@decorate
class User:
    def save(self): hit()
`,false,'User');

add('initializer-helper-dispatch-write',`def change(value): value.save = Other().save
class User:
    def __init__(self): change(self)
    def save(self): hit()
`);
add('enter-dispatch-write',`class User:
    def __enter__(self):
        self.save = Other().save
        return self
    def __exit__(self,*args): pass
    def save(self): hit()
`,true);

add('initializer-read-data-projection',`class User:
    y = 1
    def __init__(self): self.x = self.y
    def save(self): hit()
`,false,'User');
add('initializer-read-helper-data',`class User:
    def helper(self): return 1
    def __init__(self): self.x = self.helper()
    def save(self): hit()
`,false,'User');
add('initializer-read-helper-projection',`class User:
    def helper(self): return self.y
    def __init__(self):
        self.y = 1
        self.x = self.helper()
    def save(self): hit()
`,false,'User');
add('initializer-wrap-method-projection',`def wrap(value): return value
class User:
    def __init__(self): self.save = wrap(self.save)
    def save(self): hit()
`,false,'User');
for (const item of cases.slice(-2)) item.expectedReview = true;
add('initializer-helper-return-identity',`class User:
    def same(self): return self
    def __init__(self):
        alias = self.same()
        alias.__class__ = Other
    def save(self): hit()
`);
add('initializer-helper-return-stored-identity',`def mutate(value): value.__class__ = Other
class User:
    def same(self): return self
    def __init__(self):
        self.alias = self.same()
        mutate(self.alias)
    def save(self): hit()
`);
add('initializer-stored-identity',`def mutate(value): value.__class__ = Other
class User:
    def __init__(self):
        self.alias = self
        mutate(self.alias)
    def save(self): hit()
`);
add('decorator-stored-identity',`def mutate(value): value.save = Other.save
def decorate(cls):
    cls.alias = cls
    mutate(cls.alias)
    return cls
@decorate
class User:
    def save(self): hit()
`);

add('initializer-helper-return-local-alias',`class User:
    def same(self):
        alias = self
        return alias
    def __init__(self):
        alias = self.same()
        alias.__class__ = Other
    def save(self): hit()
`);
add('initializer-property-identity',`def mutate(value): value.__class__ = Other
class User:
    @property
    def identity(self): return self
    def __init__(self): mutate(self.identity)
    def save(self): hit()
`);
add('initializer-inherited-property-identity',`from base import Base
def mutate(value): value.__class__ = Other
class User(Base):
    def __init__(self): mutate(self.identity)
    def save(self): hit()
`,false,'Other',{'base.py':'class Base:\n    @property\n    def identity(self): return self\n'});
add('initializer-helper-reads-property-identity',`def mutate(value): value.identity.__class__ = Other
class User:
    @property
    def identity(self): return self
    def __init__(self): mutate(self)
    def save(self): hit()
`);

add('initializer-property-setter-changes-class',`class User:
    @property
    def value(self): return 1
    @value.setter
    def value(self, v): self.__class__ = Other
    def __init__(self): self.value = 1
    def save(self): hit()
`);
add('initializer-setattr-changes-class',`class User:
    def __setattr__(self, name, value):
        object.__setattr__(self, '__class__', Other)
    def __init__(self): self.value = 1
    def save(self): hit()
`);

add('instance-custom-lookup-replaces-method',`class User:
    def __getattribute__(self, name):
        if name == 'save': return Other().save
        return object.__getattribute__(self, name)
    def save(self): hit()
`);

add('metaclass-attribute-write-replaces-method', `class Meta(type):
    def __setattr__(cls, name, value):
        type.__setattr__(cls, 'save', Other.save)
def decorate(cls):
    cls.note = 1
    return cls
@decorate
class User(metaclass=Meta):
    def save(self): hit()
`);

// The proof is currently receiver-wide when an enter method or a helper
// writes a dispatch slot. Record that precision cost for unrelated methods.
for (const fixture of cases.filter(item => item.id.startsWith('initializer-helper-dispatch-write') ||
    item.id.startsWith('enter-dispatch-write'))) {
    cases.push({ ...fixture, id: fixture.id + '-unrelated', methodName: 'full_clean',
        expectedOwner: 'User', expectedReview: true, files: { ...fixture.files,
            'models.py': fixture.files['models.py'].replace('    def save(self): hit()',
                '    def save(self): hit()\n    def full_clean(self): hit()'),
            'views.py': fixture.files['views.py'].replaceAll('.save()', '.full_clean()'),
        } });
}

function addProperty(id, model, expectedOwner = 'User', extraFiles = {}) {
    add(id, model, false, expectedOwner, extraFiles);
}
addProperty('initializer-property-data',`class User:
    @property
    def value(self): return self._value
    @value.setter
    def value(self, value): self._value = value
    def __init__(self):
        self.value = 1
        self.copy = self.value
    def save(self): hit()
`);
addProperty('initializer-inherited-property-data',`from base import Base
class User(Base):
    def __init__(self):
        self.value = 1
        self.copy = self.value
    def save(self): hit()
`,'User',{'base.py':`class Base:
    @property
    def value(self): return self._value
    @value.setter
    def value(self, value): self._value = value
`});
addProperty('initializer-inherited-helper-data',`class Base:
    def configure(self): self.flag = 1
    def value(self): return 1
class User(Base):
    def __init__(self):
        self.configure()
        self.copy = self.value()
    def save(self): hit()
`);
addProperty('initializer-derived-helper-changes-class',`class Base:
    def __init__(self): self.configure()
    def configure(self): pass
class User(Base):
    def configure(self): self.__class__ = Other
    def save(self): hit()
`,'Other');
addProperty('initializer-getter-changes-class',`class User:
    @property
    def value(self):
        self.__class__ = Other
        return 1
    def __init__(self): self.copy = self.value
    def save(self): hit()
`,'Other');
addProperty('initializer-httpx-style-data',`class Headers:
    def __init__(self, values=None): self.values = values
    def update(self, values): self.values = values
class Base:
    @property
    def headers(self): return self._headers
    @headers.setter
    def headers(self, value):
        current = Headers({'user-agent': 'client'})
        current.update(value)
        self._headers = current
    def _build(self, value): return value
    def _mapping(self): return {'a': None}
    def __init__(self, value=None):
        self.headers = Headers(value)
        self._auth = self._build(value)
class User(Base):
    def __init__(self, value=None):
        super().__init__(value)
        self.mapping = self._mapping()
    def save(self): hit()
`);
addProperty('initializer-deep-data-literals',`class User:
    def __init__(self):
        self.data = {'outer': [{'inner': {'key': [1, 2, 3]}}]}
        if not hasattr(self, '_content'): self._content = b'content'
    def save(self): hit()
`);
addProperty('initializer-inherited-setter-changes-class',`class Base:
    @property
    def value(self): return 1
    @value.setter
    def value(self, value): self.__class__ = Other
class User(Base):
    def __init__(self): self.value = 1
    def save(self): hit()
`,'Other');
addProperty('initializer-standalone-getter-changes-class',`class User:
    @property
    def value(self):
        self.__class__ = Other
        return 1
    def __init__(self): self.value
    def save(self): hit()
`,'Other');
addProperty('initializer-custom-property-changes-class',`import builtins
def property(fn):
    def get(self):
        self.__class__ = Other
        return 1
    return builtins.property(get)
class User:
    @property
    def value(self): return 1
    def __init__(self): self.copy = self.value
    def save(self): hit()
`,'Other');
addProperty('initializer-descriptor-changes-class',`class Descriptor:
    def __get__(self, instance, owner):
        instance.__class__ = Other
        return 1
class User:
    value = Descriptor()
    def __init__(self): self.copy = self.value
    def save(self): hit()
`,'Other');
addProperty('initializer-hasattr-shadow-changes-class',`def hasattr(instance, name):
    instance.__class__ = Other
    return False
class User:
    def __init__(self):
        if not hasattr(self, '_content'): self.content = 1
    def save(self): hit()
`,'Other');

addProperty('initializer-setattr-shadow-changes-class',`def setattr(instance, name, value):
    instance.__class__ = Other
class User:
    def __init__(self): setattr(self, 'content', 1)
    def save(self): hit()
`,'Other');

addProperty('initializer-same-line-descriptor-changes-class',`class Descriptor:
    def __get__(self, instance, owner):
        instance.__class__ = Other
        return 1
class User:
    value = 0; value = Descriptor()
    def __init__(self): self.copy = self.value
    def save(self): hit()
`,'Other');

cases.push({id: 'nested-module-constructor-without-direct-qualifier', expectedOwner: 'NestedUser', expectedFile: 'pkg/models.py', expectedReview: true, files: {
    'pkg/__init__.py': 'from . import models\n',
    'pkg/models.py': 'class NestedUser:\n    def save(self): pass\n',
    'namesake.py': 'class NestedUser:\n    def save(self): pass\n',
    'views.py': 'import pkg\ndef chained():\n    pkg.models.NestedUser().save()\ndef variable():\n    value = pkg.models.NestedUser()\n    value.save()\n',
}});

describe('fix #498: construction exactness survives every lookup path', () => {
    for (const fixture of cases) it(fixture.id, () => {
        const dir = tmp(fixture.files);
        try {
            const index = idx(dir);
            const methodName = fixture.methodName || 'save';
            const targets = (index.symbols.get(methodName) || []).filter(def => def.isMethod || def.type === 'method');
            const expected = targets.find(def => def.className === (fixture.expectedOwner || 'Other') &&
                (!fixture.expectedFile || def.relativePath === fixture.expectedFile) &&
                (fixture.expectedOwner !== 'User' || def.relativePath === 'models.py'));
            assert.ok(expected, fixture.id);
            const sites = [...index.files].flatMap(([file, entry]) =>
                ['views.py', 'main.js', 'main.py'].includes(entry.relativePath)
                    ? index.getCachedCalls(file).filter(call => call.name === methodName && call.isMethod)
                        .map(call => ({ file, relative: entry.relativePath, line: call.line })) : []);
            assert.ok(sites.length >= 2, fixture.id);
            const handle = def => `${def.relativePath}:${def.startLine}:${def.name}`;
            for (const target of targets) {
                const response = execute(index, 'impact', { name: handle(target) });
                assert.ok(response.ok, response.error);
                assert.ok(response.result.account.conserved);
                for (const site of sites) {
                    const confirmed = response.result.byFile.some(group => group.file === site.relative &&
                        group.sites.some(row => row.line === site.line));
                    const review = response.result.unverifiedSites.some(row => row.file === site.relative && row.line === site.line);
                    if (target === expected) {
                        assert.ok(confirmed || review, `${fixture.id}: actual body dropped at ${site.line}`);
                        if (fixture.expectedReview) assert.ok(review && !confirmed, `${fixture.id}: expected disclosed review`);
                        else if (fixture.expectedOwner === 'User') assert.ok(confirmed, `${fixture.id}: keeping control demoted`);
                    }
                    else assert.equal(confirmed, false, `${fixture.id}: false confirmation of ${handle(target)} at ${site.line}`);
                }
            }
            for (const site of sites) {
                const enclosing = index.findEnclosingFunction(site.file, site.line, true);
                assert.ok(enclosing);
                const response = execute(index, 'context', { name: handle(enclosing), includeMethods: true });
                assert.ok(response.ok, response.error);
                const at = row => (row.siteProvenance || []).some(value => value.line === site.line) ||
                    (row.sites || []).includes(site.line);
                const confirmed = (response.result.callees || []).filter(row => row.name === methodName && at(row));
                assert.ok(confirmed.every(row => row.className === expected.className && row.relativePath === expected.relativePath), `${fixture.id}: wrong callee`);
                assert.ok(confirmed.length || response.result.unverifiedCallees.some(row => row.name === methodName && at(row)),
                    `${fixture.id}: actual callee dropped`);
            }
        } finally { rm(dir); }
    });
});


describe('fix #498: refused local constructors conserve eligible callee sites', () => {
    it('enrolls each owned call once and excludes inner class methods while retaining closures', () => {
        const dir = tmp({'a.py': `class Other:
    def save(self): pass

def replace(cls): return Other

def outer():
    @replace
    class Local:
        def save(self): pass
    value = Local()
    value.save()
    class Holder:
        def hidden(self):
            item = Local()
            item.save()
    def inner():
        item = Local()
        item.save()
    return inner

def sibling():
    @replace
    class Another:
        def save(self): pass
    value = Another()
    value.save()
`});
        try {
            const index = idx(dir);
            for (const [name, total, sites] of [['outer', 4, [11, 18]], ['inner', 2, [18]], ['hidden', 2, [15]], ['sibling', 2, [26]]]) {
                const answer = execute(index, 'context', {name, all: true});
                assert.ok(answer.ok, answer.error);
                const result = answer.result;
                assert.ok(result.meta.calleeAccount.conserved, name);
                assert.equal(result.meta.calleeAccount.unaccounted, 0, name);
                assert.equal(result.meta.calleeAccount.totalSites, total, name);
                assert.deepStrictEqual(result.unverifiedCallees.filter(row => row.name === 'save').flatMap(row => row.sites), sites, name);
            }
        } finally { rm(dir); }
    });
});

describe('fix #498: construction proof reuse follows tree and index lifetimes', () => {
    it('matches a fresh index after a helper changes and after it is restored', () => {
        const fs = require('fs'), path = require('path');
        const preserving = `class Other:
    def save(self): pass
class Base:
    def __init__(self): self.configure()
    def configure(self): self.note = 1
class User(Base):
    def save(self): pass
`;
        const replacing = preserving.replace('self.note = 1', 'self.__class__ = Other');
        const dir = tmp({'models.py': preserving, 'views.py': 'from models import User\ndef read():\n    User().save()\n'});
        try {
            const live = idx(dir);
            const answer = index => {
                const result = execute(index, 'context', {name: 'read', all: true});
                assert.ok(result.ok, result.error);
                assert.ok(result.result.meta.calleeAccount.conserved);
                return {
                    confirmed: result.result.callees.filter(row => row.name === 'save').map(row => [row.className, row.relativePath, row.sites]),
                    review: result.result.unverifiedCallees.filter(row => row.name === 'save').map(row => [row.reason, row.sites]),
                };
            };
            assert.equal(answer(live).confirmed.length, 1);
            for (const [source, confirmed] of [[replacing, 0], [preserving, 1]]) {
                fs.writeFileSync(path.join(dir, 'models.py'), source);
                live.build(null, {quiet: true});
                const current = answer(live);
                assert.equal(current.confirmed.length, confirmed);
                assert.deepStrictEqual(current, answer(idx(dir)));
                assert.deepStrictEqual(answer(live), current);
            }
        } finally { rm(dir); }
    });

    it('keeps fallback and evicted syntax trees separate inside one operation', () => {
        const path = require('path');
        const { constructionKeepsClass } = require('../core/constructed-class');
        const dir = tmp({'models.py': `class Other: pass
class Base:
    def __init__(self):
        self.configure()
        self.note = self.value
    def configure(self): self.value = 1
class GoodOne(Base): pass
class GoodTwo(Base): pass
class GoodThree(Base): pass
class GoodFour(Base): pass
class BadOne(Base):
    def configure(self): self.__class__ = Other
class BadTwo(Base):
    def configure(self): self.__class__ = Other
`});
        try {
            const index = idx(dir), file = path.join(dir, 'models.py');
            const check = (name, expected) => {
                const definition = index.symbols.get(name).find(def => def.type === 'class');
                assert.equal(constructionKeepsClass(index, definition), expected, name);
            };
            index._beginOp();
            try {
                check('GoodOne', true);
                check('BadOne', false);
                // Exercise the same deferred-release route as parsed-tree
                // cache eviction while an enclosing query still owns it.
                index._evictParsedTree(file, 'python');
                index._opTreeCache.delete(file);
                check('GoodTwo', true);
                check('BadTwo', false);
                const getTree = index._getParsedTree;
                index._getParsedTree = () => null;
                try { check('GoodThree', true); } finally { index._getParsedTree = getTree; }
                check('GoodFour', true);
            } finally { index._endOp(); }
            // The public answer remains usable after all operation-local
            // syntax facts and temporary native trees have been released.
            const result = execute(index, 'context', {name: 'models.py:3:__init__', all: true});
            assert.ok(result.ok, result.error);
            assert.ok(result.result.meta.calleeAccount.conserved);
        } finally { rm(dir); }
    });
});
