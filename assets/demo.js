(function(undefined) {
  if (typeof(this.Opal) !== 'undefined') {
    console.warn('Opal already loaded. Loading twice can cause troubles, please fix your setup.');
    return this.Opal;
  }

  // The Opal object that is exposed globally
  var Opal = this.Opal = {};

  // All bridged classes - keep track to donate methods from Object
  var bridged_classes = Opal.bridged_classes = [];

  // TopScope is used for inheriting constants from the top scope
  var TopScope = function(){};

  // Opal just acts as the top scope
  TopScope.prototype = Opal;

  // To inherit scopes
  Opal.constructor = TopScope;

  // List top scope constants
  Opal.constants = [];

  // This is a useful reference to global object inside ruby files
  Opal.global = this;

  // Minify common function calls
  var $hasOwn = Opal.hasOwnProperty;
  var $slice  = Opal.slice = Array.prototype.slice;

  // Nil object id is always 4
  var nil_id = 4;

  // Generates even sequential numbers greater than 4
  // (nil_id) to serve as unique ids for ruby objects
  var unique_id = nil_id;

  // Return next unique id
  Opal.uid = function() {
    unique_id += 2;
    return unique_id;
  };

  // Table holds all class variables
  Opal.cvars = {};

  // Globals table
  Opal.gvars = {};

  // Exit function, this should be replaced by platform specific implementation
  // (See nodejs and phantom for examples)
  Opal.exit = function(status) { if (Opal.gvars.DEBUG) console.log('Exited with status '+status); };

  /**
    Get a constant on the given scope. Every class and module in Opal has a
    scope used to store, and inherit, constants. For example, the top level
    `Object` in ruby has a scope accessible as `Opal.Object.$$scope`.

    To get the `Array` class using this scope, you could use:

        Opal.Object.$$scope.get("Array")

    If a constant with the given name cannot be found, then a dispatch to the
    class/module's `#const_method` is called, which by default will raise an
    error.

    @param [String] name the name of the constant to lookup
    @returns [RubyObject]
  */
  Opal.get = function(name) {
    var constant = this[name];

    if (constant == null) {
      return this.base.$const_missing(name);
    }

    return constant;
  };

  /*
   * Create a new constants scope for the given class with the given
   * base. Constants are looked up through their parents, so the base
   * scope will be the outer scope of the new klass.
   */
  function create_scope(base, klass, id) {
    var const_alloc = function() {};
    var const_scope = const_alloc.prototype = new base.constructor();

    klass.$$scope       = const_scope;
    klass.$$base_module = base.base;

    const_scope.base        = klass;
    const_scope.constructor = const_alloc;
    const_scope.constants   = [];

    if (id) {
      klass.$$orig_scope = base;
      base[id] = base.constructor[id] = klass;
      base.constants.push(id);
    }
  }

  Opal.create_scope = create_scope;

  /*
   * A `class Foo; end` expression in ruby is compiled to call this runtime
   * method which either returns an existing class of the given name, or creates
   * a new class in the given `base` scope.
   *
   * If a constant with the given name exists, then we check to make sure that
   * it is a class and also that the superclasses match. If either of these
   * fail, then we raise a `TypeError`. Note, superklass may be null if one was
   * not specified in the ruby code.
   *
   * We pass a constructor to this method of the form `function ClassName() {}`
   * simply so that classes show up with nicely formatted names inside debuggers
   * in the web browser (or node/sprockets).
   *
   * The `base` is the current `self` value where the class is being created
   * from. We use this to get the scope for where the class should be created.
   * If `base` is an object (not a class/module), we simple get its class and
   * use that as the base instead.
   *
   * @param [Object] base where the class is being created
   * @param [Class] superklass superclass of the new class (may be null)
   * @param [String] id the name of the class to be created
   * @param [Function] constructor function to use as constructor
   * @return [Class] new or existing ruby class
   */
  Opal.klass = function(base, superklass, id, constructor) {
    // If base is an object, use its class
    if (!base.$$is_class) {
      base = base.$$class;
    }

    // Not specifying a superclass means we can assume it to be Object
    if (superklass === null) {
      superklass = ObjectClass;
    }

    var klass = base.$$scope[id];

    // If a constant exists in the scope, then we must use that
    if ($hasOwn.call(base.$$scope, id) && klass.$$orig_scope === base.$$scope) {
      // Make sure the existing constant is a class, or raise error
      if (!klass.$$is_class) {
        throw Opal.TypeError.$new(id + " is not a class");
      }

      // Make sure existing class has same superclass
      if (superklass !== klass.$$super && superklass !== ObjectClass) {
        throw Opal.TypeError.$new("superclass mismatch for class " + id);
      }
    }
    else if (typeof(superklass) === 'function') {
      // passed native constructor as superklass, so bridge it as ruby class
      return bridge_class(id, superklass, base);
    }
    else {
      // if class doesnt exist, create a new one with given superclass
      klass = boot_class(superklass, constructor);

      // name class using base (e.g. Foo or Foo::Baz)
      klass.$$name = id;

      // every class gets its own constant scope, inherited from current scope
      create_scope(base.$$scope, klass, id);

      // Name new class directly onto current scope (Opal.Foo.Baz = klass)
      base[id] = base.$$scope[id] = klass;

      // Copy all parent constants to child, unless parent is Object
      if (superklass !== ObjectClass && superklass !== BasicObjectClass) {
        donate_constants(superklass, klass);
      }

      // call .inherited() hook with new class on the superclass
      if (superklass.$inherited) {
        superklass.$inherited(klass);
      }
    }

    return klass;
  };

  // Create generic class with given superclass.
  function boot_class(superklass, constructor) {
    var alloc = boot_class_alloc(null, constructor, superklass)

    return boot_class_object(superklass, alloc);
  }

  // Make `boot_class` available to the JS-API
  Opal.boot = boot_class;

  /*
   * The class object itself (as in `Class.new`)
   *
   * @param [(Opal) Class] superklass Another class object (as in `Class.new`)
   * @param [constructor]  alloc      The constructor that holds the prototype
   *                                  that will be used for instances of the
   *                                  newly constructed class.
   */
  function boot_class_object(superklass, alloc) {
    var singleton_class = function() {};
    singleton_class.prototype = superklass.constructor.prototype;

    function OpalClass() {}
    OpalClass.prototype = new singleton_class();

    var klass = new OpalClass();

    setup_module_or_class_object(klass, OpalClass, superklass, alloc.prototype);

    // @property $$alloc This is the constructor of instances of the current
    //                   class. Its prototype will be used for method lookup
    klass.$$alloc = alloc;

    // @property $$proto.$$class Make available to instances a reference to the
    //                           class they belong to.
    klass.$$proto.$$class = klass;

    return klass;
  }

  /*
   * Adds common/required properties to a module or class object
   * (as in `Module.new` / `Class.new`)
   *
   * @param module      The module or class that needs to be prepared
   *
   * @param constructor The constructor of the module or class itself,
   *                    usually it's already assigned by using `new`. Some
   *                    ipothesis on why it's needed can be found below.
   *
   * @param superklass  The superclass of the class/module object, for modules
   *                    is `Module` (of `ModuleClass` in JS context)
   *
   * @param prototype   The prototype on which the class/module methods will
   *                    be stored.
   */
  function setup_module_or_class_object(module, constructor, superklass, prototype) {
    // @property $$id Each class is assigned a unique `id` that helps
    //                comparation and implementation of `#object_id`
    module.$$id = Opal.uid();

    // @property $$proto This is the prototype on which methods will be defined
    module.$$proto = prototype;

    // @property constructor keeps a ref to the constructor, but apparently the
    //                       constructor is already set on:
    //
    //                          `var module = new constructor` is called.
    //
    //                       Maybe there are some browsers not abiding (IE6?)
    module.constructor = constructor;

    // @property $$is_class Clearly mark this as a class-like
    module.$$is_class = true;

    // @property $$super the superclass, doesn't get changed by module inclusions
    module.$$super = superklass;

    // @property $$parent direct parent class or module
    //                    starts with the superclass, after module inclusion is
    //                    the last included module
    module.$$parent = superklass;

    // @property $$methods keeps track of methods defined on the class
    //                     but seems to be used just by `define_basic_object_method`
    //                     and for donating (Ruby) Object methods to bridged classes
    //                     TODO: check if it can be removed
    module.$$methods = [];

    // @property $$inc included modules
    module.$$inc = [];
  }

  /**
    Define new module (or return existing module). The given `base` is basically
    the current `self` value the `module` statement was defined in. If this is
    a ruby module or class, then it is used, otherwise if the base is a ruby
    object then that objects real ruby class is used (e.g. if the base is the
    main object, then the top level `Object` class is used as the base).

    If a module of the given name is already defined in the base, then that
    instance is just returned.

    If there is a class of the given name in the base, then an error is
    generated instead (cannot have a class and module of same name in same base).

    Otherwise, a new module is created in the base with the given name, and that
    new instance is returned back (to be referenced at runtime).

    @param [RubyModule or Class] base class or module this definition is inside
    @param [String] id the name of the new (or existing) module
    @returns [RubyModule]
  */
  Opal.module = function(base, id) {
    var module;

    if (!base.$$is_class) {
      base = base.$$class;
    }

    if ($hasOwn.call(base.$$scope, id)) {
      module = base.$$scope[id];

      if (!module.$$is_mod && module !== ObjectClass) {
        throw Opal.TypeError.$new(id + " is not a module");
      }
    }
    else {
      module = boot_module_object();
      module.$$name = id;

      create_scope(base.$$scope, module, id);

      // Name new module directly onto current scope (Opal.Foo.Baz = module)
      base[id] = base.$$scope[id] = module;
    }

    return module;
  };

  /*
   * Internal function to create a new module instance. This simply sets up
   * the prototype hierarchy and method tables.
   */
  function boot_module_object() {
    var mtor = function() {};
    mtor.prototype = ModuleClass.constructor.prototype;

    function module_constructor() {}
    module_constructor.prototype = new mtor();

    var module = new module_constructor();
    var module_prototype = {};

    setup_module_or_class_object(module, module_constructor, ModuleClass, module_prototype);

    module.$$is_mod = true;
    module.$$dep    = [];

    return module;
  }

  /**
    Return the singleton class for the passed object.

    If the given object alredy has a singleton class, then it will be stored on
    the object as the `$$meta` property. If this exists, then it is simply
    returned back.

    Otherwise, a new singleton object for the class or object is created, set on
    the object at `$$meta` for future use, and then returned.

    @param [RubyObject] object the ruby object
    @returns [RubyClass] the singleton class for object
  */
  Opal.get_singleton_class = function(object) {
    if (object.$$meta) {
      return object.$$meta;
    }

    if (object.$$is_class) {
      return build_class_singleton_class(object);
    }

    return build_object_singleton_class(object);
  };

  /**
    Build the singleton class for an existing class.

    NOTE: Actually in MRI a class' singleton class inherits from its
    superclass' singleton class which in turn inherits from Class.

    @param [RubyClass] klass
    @returns [RubyClass]
   */
  function build_class_singleton_class(klass) {
    var meta = new Opal.Class.$$alloc;

    meta.$$class = Opal.Class;
    meta.$$proto = klass.constructor.prototype;

    meta.$$is_singleton = true;
    meta.$$inc          = [];
    meta.$$methods      = [];
    meta.$$scope        = klass.$$scope;

    return klass.$$meta = meta;
  }

  /**
    Build the singleton class for a Ruby (non class) Object.

    @param [RubyObject] object
    @returns [RubyClass]
   */
  function build_object_singleton_class(object) {
    var orig_class = object.$$class,
        class_id   = "#<Class:#<" + orig_class.$$name + ":" + orig_class.$$id + ">>";

    var Singleton = function () {};
    var meta = Opal.boot(orig_class, Singleton);
    meta.$$name   = class_id;

    meta.$$proto  = object;
    meta.$$class  = orig_class.$$class;
    meta.$$scope  = orig_class.$$scope;
    meta.$$parent = orig_class;
    return object.$$meta = meta;
  }

  /**
    The actual inclusion of a module into a class.

    ## Class `$$parent` and `iclass`

    To handle `super` calls, every class has a `$$parent`. This parent is
    used to resolve the next class for a super call. A normal class would
    have this point to its superclass. However, if a class includes a module
    then this would need to take into account the module. The module would
    also have to then point its `$$parent` to the actual superclass. We
    cannot modify modules like this, because it might be included in more
    then one class. To fix this, we actually insert an `iclass` as the class'
    `$$parent` which can then point to the superclass. The `iclass` acts as
    a proxy to the actual module, so the `super` chain can then search it for
    the required method.

    @param [RubyModule] module the module to include
    @param [RubyClass] klass the target class to include module into
    @returns [null]
  */
  Opal.append_features = function(module, klass) {
    var included = klass.$$inc;

    // check if this module is already included in the klass
    for (var j = 0, jj = included.length; j < jj; j++) {
      if (included[j] === module) {
        return;
      }
    }

    included.push(module);
    module.$$dep.push(klass);

    // iclass
    var iclass = {
      $$name:   module.$$name,
      $$proto:  module.$$proto,
      $$parent: klass.$$parent,
      $$module: module,
      $$iclass: true
    };

    klass.$$parent = iclass;

    var donator   = module.$$proto,
        prototype = klass.$$proto,
        methods   = module.$$methods;

    for (var i = 0, length = methods.length; i < length; i++) {
      var method = methods[i], current;


      if ( prototype.hasOwnProperty(method) &&
          !(current = prototype[method]).$$donated && !current.$$stub ) {
        // if the target class already has a method of the same name defined
        // and that method was NOT donated, then it must be a method defined
        // by the class so we do not want to override it
      }
      else {
        prototype[method] = donator[method];
        prototype[method].$$donated = true;
      }
    }

    if (klass.$$dep) {
      donate_methods(klass, methods.slice(), true);
    }

    donate_constants(module, klass);
  };

  // Boot a base class (makes instances).
  function boot_class_alloc(id, constructor, superklass) {
    if (superklass) {
      var ctor = function() {};
          ctor.prototype   = superklass.$$proto || superklass.prototype;

      if (id) {
        ctor.displayName = id;
      }

      constructor.prototype = new ctor();
    }

    constructor.prototype.constructor = constructor;

    return constructor;
  }

  /*
   * Builds the class object for core classes:
   * - make the class object have a singleton class
   * - make the singleton class inherit from its parent singleton class
   *
   * @param id         [String]      the name of the class
   * @param alloc      [Function]    the constructor for the core class instances
   * @param superclass [Class alloc] the constructor of the superclass
   */
  function boot_core_class_object(id, alloc, superclass) {
    var superclass_constructor = function() {};
        superclass_constructor.prototype = superclass.prototype;

    var singleton_class = function() {};
        singleton_class.prototype = new superclass_constructor();

    singleton_class.displayName = "#<Class:"+id+">";

    // the singleton_class acts as the class object constructor
    var klass = new singleton_class();

    setup_module_or_class_object(klass, singleton_class, superclass, alloc.prototype);

    klass.$$alloc = alloc;
    klass.$$name  = id;

    // Give all instances a ref to their class
    alloc.prototype.$$class = klass;

    Opal[id] = klass;
    Opal.constants.push(id);

    return klass;
  }

  /*
   * For performance, some core ruby classes are toll-free bridged to their
   * native javascript counterparts (e.g. a ruby Array is a javascript Array).
   *
   * This method is used to setup a native constructor (e.g. Array), to have
   * its prototype act like a normal ruby class. Firstly, a new ruby class is
   * created using the native constructor so that its prototype is set as the
   * target for th new class. Note: all bridged classes are set to inherit
   * from Object.
   *
   * Bridged classes are tracked in `bridged_classes` array so that methods
   * defined on Object can be "donated" to all bridged classes. This allows
   * us to fake the inheritance of a native prototype from our Object
   * prototype.
   *
   * Example:
   *
   *    bridge_class("Proc", Function);
   *
   * @param [String] name the name of the ruby class to create
   * @param [Function] constructor native javascript constructor to use
   * @param [Object] base where the bridge class is being created. If none is supplied, the top level scope (Opal) will be used
   * @return [Class] returns new ruby class
   */
  function bridge_class(name, constructor, base) {
    var klass = boot_class_object(ObjectClass, constructor);

    klass.$$name = name;

    if (base === undefined) {
      base = Opal;
    }
    else {
      base = base.$$scope;
    }

    create_scope(base, klass, name);
    bridged_classes.push(klass);

    var object_methods = BasicObjectClass.$$methods.concat(ObjectClass.$$methods);

    for (var i = 0, len = object_methods.length; i < len; i++) {
      var meth = object_methods[i];
      constructor.prototype[meth] = ObjectClass.$$proto[meth];
    }

    add_stubs_subscriber(constructor.prototype);

    return klass;
  }

  /*
   * constant assign
   */
  Opal.casgn = function(base_module, name, value) {
    var scope = base_module.$$scope;

    if (value.$$is_class && value.$$name === nil) {
      value.$$name = name;
    }

    if (value.$$is_class) {
      value.$$base_module = base_module;
    }

    scope.constants.push(name);
    return scope[name] = value;
  };

  /*
   * constant decl
   */
  Opal.cdecl = function(base_scope, name, value) {
    base_scope.constants.push(name);
    return base_scope[name] = value;
  };

  /*
   * When a source module is included into the target module, we must also copy
   * its constants to the target.
   */
  function donate_constants(source_mod, target_mod) {
    var source_constants = source_mod.$$scope.constants,
        target_scope     = target_mod.$$scope,
        target_constants = target_scope.constants;

    for (var i = 0, length = source_constants.length; i < length; i++) {
      target_constants.push(source_constants[i]);
      target_scope[source_constants[i]] = source_mod.$$scope[source_constants[i]];
    }
  };

  /*
   * Methods stubs are used to facilitate method_missing in opal. A stub is a
   * placeholder function which just calls `method_missing` on the receiver.
   * If no method with the given name is actually defined on an object, then it
   * is obvious to say that the stub will be called instead, and then in turn
   * method_missing will be called.
   *
   * When a file in ruby gets compiled to javascript, it includes a call to
   * this function which adds stubs for every method name in the compiled file.
   * It should then be safe to assume that method_missing will work for any
   * method call detected.
   *
   * Method stubs are added to the BasicObject prototype, which every other
   * ruby object inherits, so all objects should handle method missing. A stub
   * is only added if the given property name (method name) is not already
   * defined.
   *
   * Note: all ruby methods have a `$` prefix in javascript, so all stubs will
   * have this prefix as well (to make this method more performant).
   *
   *    Opal.add_stubs(["$foo", "$bar", "$baz="]);
   *
   * All stub functions will have a private `$$stub` property set to true so
   * that other internal methods can detect if a method is just a stub or not.
   * `Kernel#respond_to?` uses this property to detect a methods presence.
   *
   * @param [Array] stubs an array of method stubs to add
   */
  Opal.add_stubs = function(stubs) {
    var subscribers = Opal.stub_subscribers;
    var subscriber;

    for (var i = 0, length = stubs.length; i < length; i++) {
      var method_name = stubs[i], stub = stub_for(method_name);

      for (var j = 0; j < subscribers.length; j++) {
        subscriber = subscribers[j];
        if (!(method_name in subscriber)) {
          subscriber[method_name] = stub;
        }
      }
    }
  };

  /*
   * Add a prototype to the subscribers list, and (TODO) add previously stubbed
   * methods.
   *
   * @param [Prototype]
   */
  function add_stubs_subscriber(prototype) {
    // TODO: Add previously stubbed methods too.
    Opal.stub_subscribers.push(prototype);
  }

  /*
   * Keep a list of prototypes that want method_missing stubs to be added.
   *
   * @default [Prototype List] BasicObject.prototype
   */
  Opal.stub_subscribers = [BasicObject.prototype];

  /*
   * Add a method_missing stub function to the given prototype for the
   * given name.
   *
   * @param [Prototype] prototype the target prototype
   * @param [String] stub stub name to add (e.g. "$foo")
   */
  function add_stub_for(prototype, stub) {
    var method_missing_stub = stub_for(stub);
    prototype[stub] = method_missing_stub;
  }

  /*
   * Generate the method_missing stub for a given method name.
   *
   * @param [String] method_name The js-name of the method to stub (e.g. "$foo")
   */
  function stub_for(method_name) {
    function method_missing_stub() {
      // Copy any given block onto the method_missing dispatcher
      this.$method_missing.$$p = method_missing_stub.$$p;

      // Set block property to null ready for the next call (stop false-positives)
      method_missing_stub.$$p = null;

      // call method missing with correct args (remove '$' prefix on method name)
      return this.$method_missing.apply(this, [method_name.slice(1)].concat($slice.call(arguments)));
    }

    method_missing_stub.$$stub = true;

    return method_missing_stub;
  }

  // Expose for other parts of Opal to use
  Opal.add_stub_for = add_stub_for;

  // Arity count error dispatcher
  Opal.ac = function(actual, expected, object, meth) {
    var inspect = (object.$$is_class ? object.$$name + '.' : object.$$class.$$name + '#') + meth;
    var msg = '[' + inspect + '] wrong number of arguments(' + actual + ' for ' + expected + ')';
    throw Opal.ArgumentError.$new(msg);
  };

  // Super dispatcher
  Opal.find_super_dispatcher = function(obj, jsid, current_func, iter, defs) {
    var dispatcher;

    if (defs) {
      dispatcher = obj.$$is_class ? defs.$$super : obj.$$class.$$proto;
    }
    else {
      if (obj.$$is_class) {
        dispatcher = obj.$$super;
      }
      else {
        dispatcher = find_obj_super_dispatcher(obj, jsid, current_func);
      }
    }

    dispatcher = dispatcher['$' + jsid];
    dispatcher.$$p = iter;

    return dispatcher;
  };

  // Iter dispatcher for super in a block
  Opal.find_iter_super_dispatcher = function(obj, jsid, current_func, iter, defs) {
    if (current_func.$$def) {
      return Opal.find_super_dispatcher(obj, current_func.$$jsid, current_func, iter, defs);
    }
    else {
      return Opal.find_super_dispatcher(obj, jsid, current_func, iter, defs);
    }
  };

  function find_obj_super_dispatcher(obj, jsid, current_func) {
    var klass = obj.$$meta || obj.$$class;
    jsid = '$' + jsid;

    while (klass) {
      if (klass.$$proto[jsid] === current_func) {
        // ok
        break;
      }

      klass = klass.$$parent;
    }

    // if we arent in a class, we couldnt find current?
    if (!klass) {
      throw new Error("could not find current class for super()");
    }

    klass = klass.$$parent;

    // else, let's find the next one
    while (klass) {
      var working = klass.$$proto[jsid];

      if (working && working !== current_func) {
        // ok
        break;
      }

      klass = klass.$$parent;
    }

    return klass.$$proto;
  };

  /*
   * Used to return as an expression. Sometimes, we can't simply return from
   * a javascript function as if we were a method, as the return is used as
   * an expression, or even inside a block which must "return" to the outer
   * method. This helper simply throws an error which is then caught by the
   * method. This approach is expensive, so it is only used when absolutely
   * needed.
   */
  Opal.ret = function(val) {
    Opal.returner.$v = val;
    throw Opal.returner;
  };

  // handles yield calls for 1 yielded arg
  Opal.yield1 = function(block, arg) {
    if (typeof(block) !== "function") {
      throw Opal.LocalJumpError.$new("no block given");
    }

    if (block.length > 1 && arg.$$is_array) {
      return block.apply(null, arg);
    }
    else {
      return block(arg);
    }
  };

  // handles yield for > 1 yielded arg
  Opal.yieldX = function(block, args) {
    if (typeof(block) !== "function") {
      throw Opal.LocalJumpError.$new("no block given");
    }

    if (block.length > 1 && args.length == 1) {
      if (args[0].$$is_array) {
        return block.apply(null, args[0]);
      }
    }

    if (!args.$$is_array) {
      args = $slice.call(args);
    }

    return block.apply(null, args);
  };

  // Finds the corresponding exception match in candidates.  Each candidate can
  // be a value, or an array of values.  Returns null if not found.
  Opal.rescue = function(exception, candidates) {
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];

      if (candidate.$$is_array) {
        var result = Opal.rescue(exception, candidate);

        if (result) {
          return result;
        }
      }
      else if (candidate['$==='](exception)) {
        return candidate;
      }
    }

    return null;
  };

  Opal.is_a = function(object, klass) {
    if (object.$$meta === klass) {
      return true;
    }

    var search = object.$$class;

    while (search) {
      if (search === klass) {
        return true;
      }

      for (var i = 0, length = search.$$inc.length; i < length; i++) {
        if (search.$$inc[i] == klass) {
          return true;
        }
      }

      search = search.$$super;
    }

    return false;
  };

  // Helper to convert the given object to an array
  Opal.to_ary = function(value) {
    if (value.$$is_array) {
      return value;
    }
    else if (value.$to_ary && !value.$to_ary.$$stub) {
      return value.$to_ary();
    }

    return [value];
  };

  /**
    Used to get a list of rest keyword arguments. Method takes the given
    keyword args, i.e. the hash literal passed to the method containing all
    keyword arguemnts passed to method, as well as the used args which are
    the names of required and optional arguments defined. This method then
    just returns all key/value pairs which have not been used, in a new
    hash literal.

    @param given_args [Hash] all kwargs given to method
    @param used_args [Object<String: true>] all keys used as named kwargs
    @return [Hash]
   */
  Opal.kwrestargs = function(given_args, used_args) {
    var keys      = [],
        map       = {},
        key       = null,
        given_map = given_args.smap;

    for (key in given_map) {
      if (!used_args[key]) {
        keys.push(key);
        map[key] = given_map[key];
      }
    }

    return Opal.hash2(keys, map);
  };

  /*
   * Call a ruby method on a ruby object with some arguments:
   *
   *   var my_array = [1, 2, 3, 4]
   *   Opal.send(my_array, 'length')     # => 4
   *   Opal.send(my_array, 'reverse!')   # => [4, 3, 2, 1]
   *
   * A missing method will be forwarded to the object via
   * method_missing.
   *
   * The result of either call with be returned.
   *
   * @param [Object] recv the ruby object
   * @param [String] mid ruby method to call
   */
  Opal.send = function(recv, mid) {
    var args = $slice.call(arguments, 2),
        func = recv['$' + mid];

    if (func) {
      return func.apply(recv, args);
    }

    return recv.$method_missing.apply(recv, [mid].concat(args));
  };

  Opal.block_send = function(recv, mid, block) {
    var args = $slice.call(arguments, 3),
        func = recv['$' + mid];

    if (func) {
      func.$$p = block;
      return func.apply(recv, args);
    }

    return recv.$method_missing.apply(recv, [mid].concat(args));
  };

  /*
   * Donate methods for a class/module
   */
  function donate_methods(klass, defined, indirect) {
    var methods = klass.$$methods, included_in = klass.$$dep;

    // if (!indirect) {
      klass.$$methods = methods.concat(defined);
    // }

    if (included_in) {
      for (var i = 0, length = included_in.length; i < length; i++) {
        var includee = included_in[i];
        var dest     = includee.$$proto;

        for (var j = 0, jj = defined.length; j < jj; j++) {
          var method = defined[j];

          dest[method] = klass.$$proto[method];
          dest[method].$$donated = true;
        }

        if (includee.$$dep) {
          donate_methods(includee, defined, true);
        }
      }
    }
  };

  /**
    Define the given method on the module.

    This also handles donating methods to all classes that include this
    module. Method conflicts are also handled here, where a class might already
    have defined a method of the same name, or another included module defined
    the same method.

    @param [RubyModule] module the module method defined on
    @param [String] jsid javascript friendly method name (e.g. "$foo")
    @param [Function] body method body of actual function
  */
  function define_module_method(module, jsid, body) {
    module.$$proto[jsid] = body;
    body.$$owner = module;

    module.$$methods.push(jsid);

    if (module.$$module_function) {
      module[jsid] = body;
    }

    var included_in = module.$$dep;

    if (included_in) {
      for (var i = 0, length = included_in.length; i < length; i++) {
        var includee = included_in[i];
        var dest = includee.$$proto;
        var current = dest[jsid];


        if (dest.hasOwnProperty(jsid) && !current.$$donated && !current.$$stub) {
          // target class has already defined the same method name - do nothing
        }
        else if (dest.hasOwnProperty(jsid) && !current.$$stub) {
          // target class includes another module that has defined this method
          var klass_includees = includee.$$inc;

          for (var j = 0, jj = klass_includees.length; j < jj; j++) {
            if (klass_includees[j] === current.$$owner) {
              var current_owner_index = j;
            }
            if (klass_includees[j] === module) {
              var module_index = j;
            }
          }

          // only redefine method on class if the module was included AFTER
          // the module which defined the current method body. Also make sure
          // a module can overwrite a method it defined before
          if (current_owner_index <= module_index) {
            dest[jsid] = body;
            dest[jsid].$$donated = true;
          }
        }
        else {
          // neither a class, or module included by class, has defined method
          dest[jsid] = body;
          dest[jsid].$$donated = true;
        }

        if (includee.$$dep) {
          donate_methods(includee, [jsid], true);
        }
      }
    }
  }

  /**
    Used to define methods on an object. This is a helper method, used by the
    compiled source to define methods on special case objects when the compiler
    can not determine the destination object, or the object is a Module
    instance. This can get called by `Module#define_method` as well.

    ## Modules

    Any method defined on a module will come through this runtime helper.
    The method is added to the module body, and the owner of the method is
    set to be the module itself. This is used later when choosing which
    method should show on a class if more than 1 included modules define
    the same method. Finally, if the module is in `module_function` mode,
    then the method is also defined onto the module itself.

    ## Classes

    This helper will only be called for classes when a method is being
    defined indirectly; either through `Module#define_method`, or by a
    literal `def` method inside an `instance_eval` or `class_eval` body. In
    either case, the method is simply added to the class' prototype. A special
    exception exists for `BasicObject` and `Object`. These two classes are
    special because they are used in toll-free bridged classes. In each of
    these two cases, extra work is required to define the methods on toll-free
    bridged class' prototypes as well.

    ## Objects

    If a simple ruby object is the object, then the method is simply just
    defined on the object as a singleton method. This would be the case when
    a method is defined inside an `instance_eval` block.

    @param [RubyObject or Class] obj the actual obj to define method for
    @param [String] jsid the javascript friendly method name (e.g. '$foo')
    @param [Function] body the literal javascript function used as method
    @returns [null]
  */
  Opal.defn = function(obj, jsid, body) {
    if (obj.$$is_mod) {
      define_module_method(obj, jsid, body);
    }
    else if (obj.$$is_class) {
      obj.$$proto[jsid] = body;

      if (obj === BasicObjectClass) {
        define_basic_object_method(jsid, body);
      }
      else if (obj === ObjectClass) {
        donate_methods(obj, [jsid]);
      }
    }
    else {
      obj[jsid] = body;
    }

    return nil;
  };

  /*
   * Define a singleton method on the given object.
   */
  Opal.defs = function(obj, jsid, body) {
    if (obj.$$is_class || obj.$$is_mod) {
      obj.constructor.prototype[jsid] = body;
    }
    else {
      obj[jsid] = body;
    }
  };

  function define_basic_object_method(jsid, body) {
    BasicObjectClass.$$methods.push(jsid);
    for (var i = 0, len = bridged_classes.length; i < len; i++) {
      bridged_classes[i].$$proto[jsid] = body;
    }
  }

  /*
   * Called to remove a method.
   */
  Opal.undef = function(obj, jsid) {
    delete obj.$$proto[jsid];
  };

  Opal.hash = function() {
    if (arguments.length == 1 && arguments[0].$$class == Opal.Hash) {
      return arguments[0];
    }

    var hash = new Opal.Hash.$$alloc(),
        keys = [],
        _map = {},
        smap = {},
        key, obj, length, khash, map;

    hash.map   = _map;
    hash.smap  = smap;
    hash.keys  = keys;

    if (arguments.length == 1) {
      if (arguments[0].$$is_array) {
        var args = arguments[0];

        for (var i = 0, ii = args.length; i < ii; i++) {
          var pair = args[i];

          if (pair.length !== 2) {
            throw Opal.ArgumentError.$new("value not of length 2: " + pair.$inspect());
          }

          key = pair[0];
          obj = pair[1];

          if (key.$$is_string) {
            khash = key;
            map = smap;
          } else {
            khash = key.$hash();
            map = _map;
          }

          if (map[khash] == null) {
            keys.push(key);
          }

          map[khash] = obj;
        }
      }
      else {
        obj = arguments[0];
        for (key in obj) {
          khash = key.$hash();
          smap[khash] = obj[khash];
          keys.push(key);
        }
      }
    }
    else {
      length = arguments.length;
      if (length % 2 !== 0) {
        throw Opal.ArgumentError.$new("odd number of arguments for Hash");
      }

      for (var j = 0; j < length; j++) {
        key = arguments[j];
        obj = arguments[++j];

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        if (map[khash] == null) {
          keys.push(key);
        }

        map[khash] = obj;
      }
    }

    return hash;
  };

  /*
   * hash2 is a faster creator for hashes that just use symbols and
   * strings as keys. The map and keys array can be constructed at
   * compile time, so they are just added here by the constructor
   * function
   */
  Opal.hash2 = function(keys, map) {
    var hash = new Opal.Hash.$$alloc();

    hash.keys = keys;
    hash.map  = {};
    hash.smap = map;

    return hash;
  };

  /*
   * Create a new range instance with first and last values, and whether the
   * range excludes the last value.
   */
  Opal.range = function(first, last, exc) {
    var range         = new Opal.Range.$$alloc();
        range.begin   = first;
        range.end     = last;
        range.exclude = exc;

    return range;
  };

  // Require system
  // --------------
  (function(Opal) {
    var loaded_features = ['corelib/runtime'],
        require_table   = {'corelib/runtime': true},
        modules         = {};

    var current_dir  = '.';

    function mark_as_loaded(filename) {
      if (require_table[filename]) {
        return false;
      }

      loaded_features.push(filename);
      require_table[filename] = true;

      return true;
    }

    function normalize_loadable_path(path) {
      var parts, part, new_parts = [], SEPARATOR = '/';

      if (current_dir !== '.') {
        path = current_dir.replace(/\/*$/, '/') + path;
      }

      path = path.replace(/\.(rb|opal|js)$/, '');
      parts = path.split(SEPARATOR);

      for (var i = 0, ii = parts.length; i < ii; i++) {
        part = parts[i];
        if (part == '') continue;
        (part === '..') ? new_parts.pop() : new_parts.push(part)
      }

      return new_parts.join(SEPARATOR);
    }

    function load(path) {
      mark_as_loaded(path);

      var module = modules[path];

      if (module) {
        module(Opal);
      }
      else {
        var severity = Opal.dynamic_require_severity || 'warning';
        var message  = 'cannot load such file -- ' + path;

        if (severity === "error") {
          Opal.LoadError ? Opal.LoadError.$new(message) : function(){throw message}();
        }
        else if (severity === "warning") {
          console.warn('WARNING: LoadError: ' + message);
        }
      }

      return true;
    }

    function require(path) {
      if (require_table[path]) {
        return false;
      }

      return load(path);
    }

    Opal.modules         = modules;
    Opal.loaded_features = loaded_features;

    Opal.normalize_loadable_path = normalize_loadable_path;
    Opal.mark_as_loaded          = mark_as_loaded;

    Opal.load    = load;
    Opal.require = require;
  })(Opal);

  // Initialization
  // --------------

  // The actual class for BasicObject
  var BasicObjectClass;

  // The actual Object class
  var ObjectClass;

  // The actual Module class
  var ModuleClass;

  // The actual Class class
  var ClassClass;

  // Constructor for instances of BasicObject
  function BasicObject(){}

  // Constructor for instances of Object
  function Object(){}

  // Constructor for instances of Class
  function Class(){}

  // Constructor for instances of Module
  function Module(){}

  // Constructor for instances of NilClass (nil)
  function NilClass(){}

  // Constructors for *instances* of core objects
  boot_class_alloc('BasicObject', BasicObject);
  boot_class_alloc('Object',      Object,       BasicObject);
  boot_class_alloc('Module',      Module,       Object);
  boot_class_alloc('Class',       Class,        Module);

  // Constructors for *classes* of core objects
  BasicObjectClass = boot_core_class_object('BasicObject', BasicObject, Class);
  ObjectClass      = boot_core_class_object('Object',      Object,      BasicObjectClass.constructor);
  ModuleClass      = boot_core_class_object('Module',      Module,      ObjectClass.constructor);
  ClassClass       = boot_core_class_object('Class',       Class,       ModuleClass.constructor);

  // Fix booted classes to use their metaclass
  BasicObjectClass.$$class = ClassClass;
  ObjectClass.$$class      = ClassClass;
  ModuleClass.$$class      = ClassClass;
  ClassClass.$$class       = ClassClass;

  // Fix superclasses of booted classes
  BasicObjectClass.$$super = null;
  ObjectClass.$$super      = BasicObjectClass;
  ModuleClass.$$super      = ObjectClass;
  ClassClass.$$super       = ModuleClass;

  BasicObjectClass.$$parent = null;
  ObjectClass.$$parent      = BasicObjectClass;
  ModuleClass.$$parent      = ObjectClass;
  ClassClass.$$parent       = ModuleClass;

  // Internally, Object acts like a module as it is "included" into bridged
  // classes. In other words, we donate methods from Object into our bridged
  // classes as their prototypes don't inherit from our root Object, so they
  // act like module includes.
  ObjectClass.$$dep = bridged_classes;

  Opal.base                     = ObjectClass;
  BasicObjectClass.$$scope      = ObjectClass.$$scope = Opal;
  BasicObjectClass.$$orig_scope = ObjectClass.$$orig_scope = Opal;
  Opal.Kernel                   = ObjectClass;

  ModuleClass.$$scope      = ObjectClass.$$scope;
  ModuleClass.$$orig_scope = ObjectClass.$$orig_scope;
  ClassClass.$$scope       = ObjectClass.$$scope;
  ClassClass.$$orig_scope  = ObjectClass.$$orig_scope;

  ObjectClass.$$proto.toString = function() {
    return this.$to_s();
  };

  ObjectClass.$$proto.$require = Opal.require;

  Opal.top = new ObjectClass.$$alloc();

  // Nil
  Opal.klass(ObjectClass, ObjectClass, 'NilClass', NilClass);
  var nil = Opal.nil = new NilClass();
  nil.$$id = nil_id;
  nil.call = nil.apply = function() { throw Opal.LocalJumpError.$new('no block given'); };

  Opal.breaker  = new Error('unexpected break');
  Opal.returner = new Error('unexpected return');

  bridge_class('Array',     Array);
  bridge_class('Boolean',   Boolean);
  bridge_class('Numeric',   Number);
  bridge_class('String',    String);
  bridge_class('Proc',      Function);
  bridge_class('Exception', Error);
  bridge_class('Regexp',    RegExp);
  bridge_class('Time',      Date);

  TypeError.$$super = Error;
}).call(this);

if (typeof(global) !== 'undefined') {
  global.Opal = this.Opal;
  Opal.global = global;
}
if (typeof(window) !== 'undefined') {
  window.Opal = this.Opal;
  Opal.global = window;
}
Opal.mark_as_loaded(Opal.normalize_loadable_path("corelib/runtime"));
/* Generated by Opal 0.8.0 */
Opal.modules["corelib/helpers"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module;

  Opal.add_stubs(['$new', '$class', '$===', '$respond_to?', '$raise', '$type_error', '$__send__', '$coerce_to', '$nil?', '$<=>', '$inspect']);
  return (function($base) {
    var self = $module($base, 'Opal');

    var def = self.$$proto, $scope = self.$$scope;

    Opal.defs(self, '$type_error', function(object, type, method, coerced) {
      var $a, $b, self = this;

      if (method == null) {
        method = nil
      }
      if (coerced == null) {
        coerced = nil
      }
      if ((($a = (($b = method !== false && method !== nil) ? coerced : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return $scope.get('TypeError').$new("can't convert " + (object.$class()) + " into " + (type) + " (" + (object.$class()) + "#" + (method) + " gives " + (coerced.$class()))
        } else {
        return $scope.get('TypeError').$new("no implicit conversion of " + (object.$class()) + " into " + (type))
      };
    });

    Opal.defs(self, '$coerce_to', function(object, type, method) {
      var $a, self = this;

      if ((($a = type['$==='](object)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return object};
      if ((($a = object['$respond_to?'](method)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type))
      };
      return object.$__send__(method);
    });

    Opal.defs(self, '$coerce_to!', function(object, type, method) {
      var $a, self = this, coerced = nil;

      coerced = self.$coerce_to(object, type, method);
      if ((($a = type['$==='](coerced)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type, method, coerced))
      };
      return coerced;
    });

    Opal.defs(self, '$coerce_to?', function(object, type, method) {
      var $a, self = this, coerced = nil;

      if ((($a = object['$respond_to?'](method)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        return nil
      };
      coerced = self.$coerce_to(object, type, method);
      if ((($a = coerced['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        return nil};
      if ((($a = type['$==='](coerced)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type, method, coerced))
      };
      return coerced;
    });

    Opal.defs(self, '$try_convert', function(object, type, method) {
      var $a, self = this;

      if ((($a = type['$==='](object)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return object};
      if ((($a = object['$respond_to?'](method)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return object.$__send__(method)
        } else {
        return nil
      };
    });

    Opal.defs(self, '$compare', function(a, b) {
      var $a, self = this, compare = nil;

      compare = a['$<=>'](b);
      if ((($a = compare === nil) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (a.$class()) + " with " + (b.$class()) + " failed")};
      return compare;
    });

    Opal.defs(self, '$destructure', function(args) {
      var self = this;

      
      if (args.length == 1) {
        return args[0];
      }
      else if (args.$$is_array) {
        return args;
      }
      else {
        return $slice.call(args);
      }
    
    });

    Opal.defs(self, '$respond_to?', function(obj, method) {
      var self = this;

      
      if (obj == null || !obj.$$class) {
        return false;
      }
    
      return obj['$respond_to?'](method);
    });

    Opal.defs(self, '$inspect', function(obj) {
      var self = this;

      
      if (obj === undefined) {
        return "undefined";
      }
      else if (obj === null) {
        return "null";
      }
      else if (!obj.$$class) {
        return obj.toString();
      }
      else {
        return obj.$inspect();
      }
    
    });
  })(self)
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/module"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$attr_reader', '$attr_writer', '$coerce_to!', '$raise', '$=~', '$[]', '$!', '$==', '$inject', '$const_get', '$split', '$const_missing', '$to_str', '$===', '$to_proc', '$lambda', '$bind', '$call', '$class', '$append_features', '$included', '$name', '$new', '$to_s', '$__id__']);
  return (function($base, $super) {
    function $Module(){};
    var self = $Module = $klass($base, $super, 'Module', $Module);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_3, TMP_5, TMP_6;

    Opal.defs(self, '$new', TMP_1 = function() {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      
      function AnonModule(){}
      var klass      = Opal.boot(Opal.Module, AnonModule);
      klass.$$name   = nil;
      klass.$$class  = Opal.Module;
      klass.$$dep    = []
      klass.$$is_mod = true;
      klass.$$proto  = {};

      // inherit scope from parent
      Opal.create_scope(Opal.Module.$$scope, klass);

      if (block !== nil) {
        var block_self = block.$$s;
        block.$$s = null;
        block.call(klass);
        block.$$s = block_self;
      }

      return klass;
    
    });

    def['$==='] = function(object) {
      var $a, self = this;

      if ((($a = object == null) !== nil && (!$a.$$is_boolean || $a == true))) {
        return false};
      return Opal.is_a(object, self);
    };

    def['$<'] = function(other) {
      var self = this;

      
      var working = self;

      while (working) {
        if (working === other) {
          return true;
        }

        working = working.$$parent;
      }

      return false;
    
    };

    def.$alias_method = function(newname, oldname) {
      var self = this;

      
      var newjsid = '$' + newname,
          body    = self.$$proto['$' + oldname];

      if (self.$$is_singleton) {
        self.$$proto[newjsid] = body;
      }
      else {
        Opal.defn(self, newjsid, body);
      }

      return self;
    
      return self;
    };

    def.$alias_native = function(mid, jsid) {
      var self = this;

      if (jsid == null) {
        jsid = mid
      }
      return self.$$proto['$' + mid] = self.$$proto[jsid];
    };

    def.$ancestors = function() {
      var self = this;

      
      var parent = self,
          result = [];

      while (parent) {
        result.push(parent);
        result = result.concat(parent.$$inc);

        parent = parent.$$super;
      }

      return result;
    
    };

    def.$append_features = function(klass) {
      var self = this;

      Opal.append_features(self, klass);
      return self;
    };

    def.$attr_accessor = function(names) {
      var $a, $b, self = this;

      names = $slice.call(arguments, 0);
      ($a = self).$attr_reader.apply($a, [].concat(names));
      return ($b = self).$attr_writer.apply($b, [].concat(names));
    };

    Opal.defn(self, '$attr', def.$attr_accessor);

    def.$attr_reader = function(names) {
      var self = this;

      names = $slice.call(arguments, 0);
      
      var proto = self.$$proto;

      for (var i = names.length - 1; i >= 0; i--) {
        var name = names[i],
            id   = '$' + name;

        // the closure here is needed because name will change at the next
        // cycle, I wish we could use let.
        var body = (function(name) {
          return function() {
            return this[name];
          };
        })(name);

        // initialize the instance variable as nil
        proto[name] = nil;

        if (self.$$is_singleton) {
          proto.constructor.prototype[id] = body;
        }
        else {
          Opal.defn(self, id, body);
        }
      }
    
      return nil;
    };

    def.$attr_writer = function(names) {
      var self = this;

      names = $slice.call(arguments, 0);
      
      var proto = self.$$proto;

      for (var i = names.length - 1; i >= 0; i--) {
        var name = names[i],
            id   = '$' + name + '=';

        // the closure here is needed because name will change at the next
        // cycle, I wish we could use let.
        var body = (function(name){
          return function(value) {
            return this[name] = value;
          }
        })(name);

        // initialize the instance variable as nil
        proto[name] = nil;

        if (self.$$is_singleton) {
          proto.constructor.prototype[id] = body;
        }
        else {
          Opal.defn(self, id, body);
        }
      }
    
      return nil;
    };

    def.$autoload = function(const$, path) {
      var self = this;

      
      var autoloaders;

      if (!(autoloaders = self.$$autoload)) {
        autoloaders = self.$$autoload = {};
      }

      autoloaders[const$] = path;
      return nil;
    ;
    };

    def.$class_variable_get = function(name) {
      var $a, self = this;

      name = $scope.get('Opal')['$coerce_to!'](name, $scope.get('String'), "to_str");
      if ((($a = name.length < 3 || name.slice(0,2) !== '@@') !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('NameError'), "class vars should start with @@")};
      
      var value = Opal.cvars[name.slice(2)];
      (function() {if ((($a = value == null) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.$raise($scope.get('NameError'), "uninitialized class variable @@a in")
        } else {
        return nil
      }; return nil; })()
      return value;
    
    };

    def.$class_variable_set = function(name, value) {
      var $a, self = this;

      name = $scope.get('Opal')['$coerce_to!'](name, $scope.get('String'), "to_str");
      if ((($a = name.length < 3 || name.slice(0,2) !== '@@') !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('NameError'))};
      
      Opal.cvars[name.slice(2)] = value;
      return value;
    
    };

    def.$constants = function() {
      var self = this;

      return self.$$scope.constants;
    };

    def['$const_defined?'] = function(name, inherit) {
      var $a, self = this;

      if (inherit == null) {
        inherit = true
      }
      if ((($a = name['$=~'](/^[A-Z]\w*$/)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('NameError'), "wrong constant name " + (name))
      };
      
      var scopes = [self.$$scope];

      if (inherit || self === Opal.Object) {
        var parent = self.$$super;

        while (parent !== Opal.BasicObject) {
          scopes.push(parent.$$scope);

          parent = parent.$$super;
        }
      }

      for (var i = 0, length = scopes.length; i < length; i++) {
        if (scopes[i].hasOwnProperty(name)) {
          return true;
        }
      }

      return false;
    
    };

    def.$const_get = function(name, inherit) {
      var $a, $b, TMP_2, self = this;

      if (inherit == null) {
        inherit = true
      }
      if ((($a = ($b = name['$[]']("::"), $b !== false && $b !== nil ?name['$==']("::")['$!']() : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return ($a = ($b = name.$split("::")).$inject, $a.$$p = (TMP_2 = function(o, c){var self = TMP_2.$$s || this;
if (o == null) o = nil;if (c == null) c = nil;
        return o.$const_get(c)}, TMP_2.$$s = self, TMP_2), $a).call($b, self)};
      if ((($a = name['$=~'](/^[A-Z]\w*$/)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('NameError'), "wrong constant name " + (name))
      };
      
      var scopes = [self.$$scope];

      if (inherit || self == Opal.Object) {
        var parent = self.$$super;

        while (parent !== Opal.BasicObject) {
          scopes.push(parent.$$scope);

          parent = parent.$$super;
        }
      }

      for (var i = 0, length = scopes.length; i < length; i++) {
        if (scopes[i].hasOwnProperty(name)) {
          return scopes[i][name];
        }
      }

      return self.$const_missing(name);
    
    };

    def.$const_missing = function(name) {
      var self = this;

      
      if (self.$$autoload) {
        var file = self.$$autoload[name];

        if (file) {
          self.$require(file);

          return self.$const_get(name);
        }
      }
    
      return self.$raise($scope.get('NameError'), "uninitialized constant " + (self) + "::" + (name));
    };

    def.$const_set = function(name, value) {
      var $a, self = this;

      if ((($a = name['$=~'](/^[A-Z]\w*$/)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('NameError'), "wrong constant name " + (name))
      };
      try {
      name = name.$to_str()
      } catch ($err) {if (true) {
        self.$raise($scope.get('TypeError'), "conversion with #to_str failed")
        }else { throw $err; }
      };
      Opal.casgn(self, name, value);
      return value;
    };

    def.$define_method = TMP_3 = function(name, method) {
      var $a, $b, $c, TMP_4, self = this, $iter = TMP_3.$$p, block = $iter || nil, $case = nil;

      TMP_3.$$p = null;
      if ((($a = method === undefined && !(block !== nil)) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "tried to create a Proc object without a block")};
      ((($a = block) !== false && $a !== nil) ? $a : block = (function() {$case = method;if ($scope.get('Proc')['$===']($case)) {return method}else if ($scope.get('Method')['$===']($case)) {return method.$to_proc()}else if ($scope.get('UnboundMethod')['$===']($case)) {return ($b = ($c = self).$lambda, $b.$$p = (TMP_4 = function(args){var self = TMP_4.$$s || this, $a, bound = nil;
args = $slice.call(arguments, 0);
      bound = method.$bind(self);
        return ($a = bound).$call.apply($a, [].concat(args));}, TMP_4.$$s = self, TMP_4), $b).call($c)}else {return self.$raise($scope.get('TypeError'), "wrong argument type " + (block.$class()) + " (expected Proc/Method)")}})());
      
      var id = '$' + name;

      block.$$jsid = name;
      block.$$s    = null;
      block.$$def  = block;

      if (self.$$is_singleton) {
        self.$$proto[id] = block;
      }
      else {
        Opal.defn(self, id, block);
      }

      return name;
    
    };

    def.$remove_method = function(name) {
      var self = this;

      Opal.undef(self, '$' + name);
      return self;
    };

    def.$include = function(mods) {
      var self = this;

      mods = $slice.call(arguments, 0);
      
      for (var i = mods.length - 1; i >= 0; i--) {
        var mod = mods[i];

        if (mod === self) {
          continue;
        }

        (mod).$append_features(self);
        (mod).$included(self);
      }
    
      return self;
    };

    def['$include?'] = function(mod) {
      var self = this;

      
      for (var cls = self; cls; cls = cls.$$super) {
        for (var i = 0; i != cls.$$inc.length; i++) {
          var mod2 = cls.$$inc[i];
          if (mod === mod2) {
            return true;
          }
        }
      }
      return false;
    
    };

    def.$instance_method = function(name) {
      var self = this;

      
      var meth = self.$$proto['$' + name];

      if (!meth || meth.$$stub) {
        self.$raise($scope.get('NameError'), "undefined method `" + (name) + "' for class `" + (self.$name()) + "'");
      }

      return $scope.get('UnboundMethod').$new(self, meth, name);
    
    };

    def.$instance_methods = function(include_super) {
      var self = this;

      if (include_super == null) {
        include_super = true
      }
      
      var methods = [],
          proto   = self.$$proto;

      for (var prop in proto) {
        if (!(prop.charAt(0) === '$')) {
          continue;
        }

        if (!(typeof(proto[prop]) === "function")) {
          continue;
        }

        if (proto[prop].$$stub) {
          continue;
        }

        if (!self.$$is_mod) {
          if (self !== Opal.BasicObject && proto[prop] === Opal.BasicObject.$$proto[prop]) {
            continue;
          }

          if (!include_super && !proto.hasOwnProperty(prop)) {
            continue;
          }

          if (!include_super && proto[prop].$$donated) {
            continue;
          }
        }

        methods.push(prop.substr(1));
      }

      return methods;
    
    };

    def.$included = function(mod) {
      var self = this;

      return nil;
    };

    def.$extended = function(mod) {
      var self = this;

      return nil;
    };

    def.$module_eval = TMP_5 = function() {
      var self = this, $iter = TMP_5.$$p, block = $iter || nil;

      TMP_5.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        self.$raise($scope.get('ArgumentError'), "no block given")
      };
      
      var old = block.$$s,
          result;

      block.$$s = null;
      result = block.call(self);
      block.$$s = old;

      return result;
    
    };

    Opal.defn(self, '$class_eval', def.$module_eval);

    def.$module_exec = TMP_6 = function() {
      var self = this, $iter = TMP_6.$$p, block = $iter || nil;

      TMP_6.$$p = null;
      
      if (block === nil) {
        throw new Error("no block given");
      }

      var block_self = block.$$s, result;

      block.$$s = null;
      result = block.apply(self, $slice.call(arguments));
      block.$$s = block_self;

      return result;
    
    };

    Opal.defn(self, '$class_exec', def.$module_exec);

    def['$method_defined?'] = function(method) {
      var self = this;

      
      var body = self.$$proto['$' + method];
      return (!!body) && !body.$$stub;
    
    };

    def.$module_function = function(methods) {
      var self = this;

      methods = $slice.call(arguments, 0);
      
      if (methods.length === 0) {
        self.$$module_function = true;
      }
      else {
        for (var i = 0, length = methods.length; i < length; i++) {
          var meth = methods[i], func = self.$$proto['$' + meth];

          self.constructor.prototype['$' + meth] = func;
        }
      }

      return self;
    
    };

    def.$name = function() {
      var self = this;

      
      if (self.$$full_name) {
        return self.$$full_name;
      }

      var result = [], base = self;

      while (base) {
        if (base.$$name === nil) {
          return result.length === 0 ? nil : result.join('::');
        }

        result.unshift(base.$$name);

        base = base.$$base_module;

        if (base === Opal.Object) {
          break;
        }
      }

      if (result.length === 0) {
        return nil;
      }

      return self.$$full_name = result.join('::');
    
    };

    def.$public = function(methods) {
      var self = this;

      methods = $slice.call(arguments, 0);
      
      if (methods.length === 0) {
        self.$$module_function = false;
      }

      return nil;
    
    };

    Opal.defn(self, '$private', def.$public);

    Opal.defn(self, '$protected', def.$public);

    Opal.defn(self, '$nesting', def.$public);

    def.$private_class_method = function(name) {
      var self = this;

      return self['$' + name] || nil;
    };

    Opal.defn(self, '$public_class_method', def.$private_class_method);

    def['$private_method_defined?'] = function(obj) {
      var self = this;

      return false;
    };

    def.$private_constant = function() {
      var self = this;

      return nil;
    };

    Opal.defn(self, '$protected_method_defined?', def['$private_method_defined?']);

    Opal.defn(self, '$public_instance_methods', def.$instance_methods);

    Opal.defn(self, '$public_method_defined?', def['$method_defined?']);

    def.$remove_class_variable = function() {
      var self = this;

      return nil;
    };

    def.$remove_const = function(name) {
      var self = this;

      
      var old = self.$$scope[name];
      delete self.$$scope[name];
      return old;
    
    };

    def.$to_s = function() {
      var $a, self = this;

      return ((($a = self.$$name) !== false && $a !== nil) ? $a : "#<" + (self.$$is_mod ? 'Module' : 'Class') + ":0x" + (self.$__id__().$to_s(16)) + ">");
    };

    return (def.$undef_method = function(symbol) {
      var self = this;

      Opal.add_stub_for(self.$$proto, "$" + symbol);
      return self;
    }, nil) && 'undef_method';
  })(self, null)
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/class"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$raise', '$allocate']);
  self.$require("corelib/module");
  return (function($base, $super) {
    function $Class(){};
    var self = $Class = $klass($base, $super, 'Class', $Class);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2;

    Opal.defs(self, '$new', TMP_1 = function(sup) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      if (sup == null) {
        sup = $scope.get('Object')
      }
      TMP_1.$$p = null;
      
      if (!sup.$$is_class || sup.$$is_mod) {
        self.$raise($scope.get('TypeError'), "superclass must be a Class");
      }

      function AnonClass(){};
      var klass      = Opal.boot(sup, AnonClass)
      klass.$$name   = nil;
      klass.$$parent = sup;

      // inherit scope from parent
      Opal.create_scope(sup.$$scope, klass);

      sup.$inherited(klass);

      if (block !== nil) {
        var block_self = block.$$s;
        block.$$s = null;
        block.call(klass);
        block.$$s = block_self;
      }

      return klass;
    ;
    });

    def.$allocate = function() {
      var self = this;

      
      var obj = new self.$$alloc;
      obj.$$id = Opal.uid();
      return obj;
    
    };

    def.$inherited = function(cls) {
      var self = this;

      return nil;
    };

    def.$new = TMP_2 = function(args) {
      var self = this, $iter = TMP_2.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_2.$$p = null;
      
      var obj = self.$allocate();

      obj.$initialize.$$p = block;
      obj.$initialize.apply(obj, args);
      return obj;
    ;
    };

    return (def.$superclass = function() {
      var self = this;

      return self.$$super || nil;
    }, nil) && 'superclass';
  })(self, null);
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/basic_object"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$raise', '$inspect']);
  return (function($base, $super) {
    function $BasicObject(){};
    var self = $BasicObject = $klass($base, $super, 'BasicObject', $BasicObject);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4;

    Opal.defn(self, '$initialize', function() {
      var self = this;

      return nil;
    });

    Opal.defn(self, '$==', function(other) {
      var self = this;

      return self === other;
    });

    Opal.defn(self, '$__id__', function() {
      var self = this;

      return self.$$id || (self.$$id = Opal.uid());
    });

    Opal.defn(self, '$__send__', TMP_1 = function(symbol, args) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_1.$$p = null;
      
      var func = self['$' + symbol]

      if (func) {
        if (block !== nil) {
          func.$$p = block;
        }

        return func.apply(self, args);
      }

      if (block !== nil) {
        self.$method_missing.$$p = block;
      }

      return self.$method_missing.apply(self, [symbol].concat(args));
    
    });

    Opal.defn(self, '$!', function() {
      var self = this;

      return false;
    });

    Opal.defn(self, '$eql?', def['$==']);

    Opal.defn(self, '$equal?', def['$==']);

    Opal.defn(self, '$instance_eval', TMP_2 = function() {
      var self = this, $iter = TMP_2.$$p, block = $iter || nil;

      TMP_2.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        $scope.get('Kernel').$raise($scope.get('ArgumentError'), "no block given")
      };
      
      var old = block.$$s,
          result;

      block.$$s = null;
      result = block.call(self, self);
      block.$$s = old;

      return result;
    
    });

    Opal.defn(self, '$instance_exec', TMP_3 = function(args) {
      var self = this, $iter = TMP_3.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_3.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        $scope.get('Kernel').$raise($scope.get('ArgumentError'), "no block given")
      };
      
      var block_self = block.$$s,
          result;

      block.$$s = null;
      result = block.apply(self, args);
      block.$$s = block_self;

      return result;
    
    });

    return (Opal.defn(self, '$method_missing', TMP_4 = function(symbol, args) {
      var $a, self = this, $iter = TMP_4.$$p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_4.$$p = null;
      return $scope.get('Kernel').$raise($scope.get('NoMethodError'), (function() {if ((($a = self.$inspect && !self.$inspect.$$stub) !== nil && (!$a.$$is_boolean || $a == true))) {
        return "undefined method `" + (symbol) + "' for " + (self.$inspect()) + ":" + (self.$$class)
        } else {
        return "undefined method `" + (symbol) + "' for " + (self.$$class)
      }; return nil; })());
    }), nil) && 'method_missing';
  })(self, null)
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/kernel"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  function $rb_le(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs <= rhs : lhs['$<='](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $gvars = Opal.gvars, $hash2 = Opal.hash2;

  Opal.add_stubs(['$raise', '$inspect', '$==', '$object_id', '$class', '$new', '$coerce_to?', '$<<', '$allocate', '$copy_instance_variables', '$initialize_clone', '$initialize_copy', '$singleton_class', '$initialize_dup', '$for', '$to_proc', '$each', '$reverse', '$append_features', '$extended', '$length', '$respond_to?', '$[]', '$nil?', '$to_a', '$to_int', '$fetch', '$Integer', '$Float', '$to_ary', '$to_str', '$coerce_to', '$to_s', '$__id__', '$coerce_to!', '$===', '$print', '$format', '$puts', '$empty?', '$rand', '$respond_to_missing?', '$try_convert!', '$expand_path', '$join', '$start_with?']);
  return (function($base) {
    var self = $module($base, 'Kernel');

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_9;

    Opal.defn(self, '$method_missing', TMP_1 = function(symbol, args) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_1.$$p = null;
      return self.$raise($scope.get('NoMethodError'), "undefined method `" + (symbol) + "' for " + (self.$inspect()));
    });

    Opal.defn(self, '$=~', function(obj) {
      var self = this;

      return false;
    });

    Opal.defn(self, '$===', function(other) {
      var $a, self = this;

      return ((($a = self.$object_id()['$=='](other.$object_id())) !== false && $a !== nil) ? $a : self['$=='](other));
    });

    Opal.defn(self, '$<=>', function(other) {
      var self = this;

      
      var x = self['$=='](other);

      if (x && x !== nil) {
        return 0;
      }

      return nil;
    ;
    });

    Opal.defn(self, '$method', function(name) {
      var self = this;

      
      var meth = self['$' + name];

      if (!meth || meth.$$stub) {
        self.$raise($scope.get('NameError'), "undefined method `" + (name) + "' for class `" + (self.$class()) + "'");
      }

      return $scope.get('Method').$new(self, meth, name);
    
    });

    Opal.defn(self, '$methods', function(all) {
      var self = this;

      if (all == null) {
        all = true
      }
      
      var methods = [];

      for (var key in self) {
        if (key[0] == "$" && typeof(self[key]) === "function") {
          if (all == false || all === nil) {
            if (!Opal.hasOwnProperty.call(self, key)) {
              continue;
            }
          }
          if (self[key].$$stub === undefined) {
            methods.push(key.substr(1));
          }
        }
      }

      return methods;
    
    });

    Opal.defn(self, '$Array', function(object) {
      var self = this;

      
      var coerced;

      if (object === nil) {
        return [];
      }

      if (object.$$is_array) {
        return object;
      }

      coerced = $scope.get('Opal')['$coerce_to?'](object, $scope.get('Array'), "to_ary");
      if (coerced !== nil) { return coerced; }

      coerced = $scope.get('Opal')['$coerce_to?'](object, $scope.get('Array'), "to_a");
      if (coerced !== nil) { return coerced; }

      return [object];
    
    });

    Opal.defn(self, '$at_exit', TMP_2 = function() {
      var $a, self = this, $iter = TMP_2.$$p, block = $iter || nil;
      if ($gvars.__at_exit__ == null) $gvars.__at_exit__ = nil;

      TMP_2.$$p = null;
      ((($a = $gvars.__at_exit__) !== false && $a !== nil) ? $a : $gvars.__at_exit__ = []);
      return $gvars.__at_exit__['$<<'](block);
    });

    Opal.defn(self, '$caller', function() {
      var self = this;

      return [];
    });

    Opal.defn(self, '$class', function() {
      var self = this;

      return self.$$class;
    });

    Opal.defn(self, '$copy_instance_variables', function(other) {
      var self = this;

      
      for (var name in other) {
        if (name.charAt(0) !== '$') {
          self[name] = other[name];
        }
      }
    
    });

    Opal.defn(self, '$clone', function() {
      var self = this, copy = nil;

      copy = self.$class().$allocate();
      copy.$copy_instance_variables(self);
      copy.$initialize_clone(self);
      return copy;
    });

    Opal.defn(self, '$initialize_clone', function(other) {
      var self = this;

      return self.$initialize_copy(other);
    });

    Opal.defn(self, '$define_singleton_method', TMP_3 = function(name, body) {
      var $a, self = this, $iter = TMP_3.$$p, block = $iter || nil;

      if (body == null) {
        body = nil
      }
      TMP_3.$$p = null;
      ((($a = body) !== false && $a !== nil) ? $a : body = block);
      if (body !== false && body !== nil) {
        } else {
        self.$raise($scope.get('ArgumentError'), "tried to create Proc object without a block")
      };
      
      var jsid   = '$' + name;
      body.$$jsid = name;
      body.$$s    = null;
      body.$$def  = body;

      self.$singleton_class().$$proto[jsid] = body;

      return self;
    
    });

    Opal.defn(self, '$dup', function() {
      var self = this, copy = nil;

      copy = self.$class().$allocate();
      copy.$copy_instance_variables(self);
      copy.$initialize_dup(self);
      return copy;
    });

    Opal.defn(self, '$initialize_dup', function(other) {
      var self = this;

      return self.$initialize_copy(other);
    });

    Opal.defn(self, '$enum_for', TMP_4 = function(method, args) {
      var $a, $b, self = this, $iter = TMP_4.$$p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      if (method == null) {
        method = "each"
      }
      TMP_4.$$p = null;
      return ($a = ($b = $scope.get('Enumerator')).$for, $a.$$p = block.$to_proc(), $a).apply($b, [self, method].concat(args));
    });

    Opal.defn(self, '$to_enum', def.$enum_for);

    Opal.defn(self, '$equal?', function(other) {
      var self = this;

      return self === other;
    });

    Opal.defn(self, '$exit', function(status) {
      var $a, $b, self = this;
      if ($gvars.__at_exit__ == null) $gvars.__at_exit__ = nil;

      if (status == null) {
        status = true
      }
      if ((($a = $gvars.__at_exit__) !== nil && (!$a.$$is_boolean || $a == true))) {
        ($a = ($b = $gvars.__at_exit__.$reverse()).$each, $a.$$p = "call".$to_proc(), $a).call($b)};
      if ((($a = status === true) !== nil && (!$a.$$is_boolean || $a == true))) {
        status = 0};
      Opal.exit(status);
      return nil;
    });

    Opal.defn(self, '$extend', function(mods) {
      var self = this;

      mods = $slice.call(arguments, 0);
      
      var singleton = self.$singleton_class();

      for (var i = mods.length - 1; i >= 0; i--) {
        var mod = mods[i];

        (mod).$append_features(singleton);
        (mod).$extended(self);
      }
    ;
      return self;
    });

    Opal.defn(self, '$format', function(format_string, args) {
      var $a, $b, self = this, ary = nil;
      if ($gvars.DEBUG == null) $gvars.DEBUG = nil;

      args = $slice.call(arguments, 1);
      if ((($a = (($b = args.$length()['$=='](1)) ? args['$[]'](0)['$respond_to?']("to_ary") : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        ary = $scope.get('Opal')['$coerce_to?'](args['$[]'](0), $scope.get('Array'), "to_ary");
        if ((($a = ary['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          args = ary.$to_a()
        };};
      
      var result = '',
          //used for slicing:
          begin_slice = 0,
          end_slice,
          //used for iterating over the format string:
          i,
          len = format_string.length,
          //used for processing field values:
          arg,
          str,
          //used for processing %g and %G fields:
          exponent,
          //used for keeping track of width and precision:
          width,
          precision,
          //used for holding temporary values:
          tmp_num,
          //used for processing %{} and %<> fileds:
          hash_parameter_key,
          closing_brace_char,
          //used for processing %b, %B, %o, %x, and %X fields:
          base_number,
          base_prefix,
          base_neg_zero_regex,
          base_neg_zero_digit,
          //used for processing arguments:
          next_arg,
          seq_arg_num = 1,
          pos_arg_num = 0,
          //used for keeping track of flags:
          flags,
          FNONE  = 0,
          FSHARP = 1,
          FMINUS = 2,
          FPLUS  = 4,
          FZERO  = 8,
          FSPACE = 16,
          FWIDTH = 32,
          FPREC  = 64,
          FPREC0 = 128;

      function CHECK_FOR_FLAGS() {
        if (flags&FWIDTH) { self.$raise($scope.get('ArgumentError'), "flag after width") }
        if (flags&FPREC0) { self.$raise($scope.get('ArgumentError'), "flag after precision") }
      }

      function CHECK_FOR_WIDTH() {
        if (flags&FWIDTH) { self.$raise($scope.get('ArgumentError'), "width given twice") }
        if (flags&FPREC0) { self.$raise($scope.get('ArgumentError'), "width after precision") }
      }

      function GET_NTH_ARG(num) {
        if (num >= args.length) { self.$raise($scope.get('ArgumentError'), "too few arguments") }
        return args[num];
      }

      function GET_NEXT_ARG() {
        switch (pos_arg_num) {
        case -1: self.$raise($scope.get('ArgumentError'), "unnumbered(" + (seq_arg_num) + ") mixed with numbered")
        case -2: self.$raise($scope.get('ArgumentError'), "unnumbered(" + (seq_arg_num) + ") mixed with named")
        }
        pos_arg_num = seq_arg_num++;
        return GET_NTH_ARG(pos_arg_num - 1);
      }

      function GET_POS_ARG(num) {
        if (pos_arg_num > 0) {
          self.$raise($scope.get('ArgumentError'), "numbered(" + (num) + ") after unnumbered(" + (pos_arg_num) + ")")
        }
        if (pos_arg_num === -2) {
          self.$raise($scope.get('ArgumentError'), "numbered(" + (num) + ") after named")
        }
        if (num < 1) {
          self.$raise($scope.get('ArgumentError'), "invalid index - " + (num) + "$")
        }
        pos_arg_num = -1;
        return GET_NTH_ARG(num - 1);
      }

      function GET_ARG() {
        return (next_arg === undefined ? GET_NEXT_ARG() : next_arg);
      }

      function READ_NUM(label) {
        var num, str = '';
        for (;; i++) {
          if (i === len) {
            self.$raise($scope.get('ArgumentError'), "malformed format string - %*[0-9]")
          }
          if (format_string.charCodeAt(i) < 48 || format_string.charCodeAt(i) > 57) {
            i--;
            num = parseInt(str) || 0;
            if (num > 2147483647) {
              self.$raise($scope.get('ArgumentError'), "" + (label) + " too big")
            }
            return num;
          }
          str += format_string.charAt(i);
        }
      }

      function READ_NUM_AFTER_ASTER(label) {
        var arg, num = READ_NUM(label);
        if (format_string.charAt(i + 1) === '$') {
          i++;
          arg = GET_POS_ARG(num);
        } else {
          arg = GET_NEXT_ARG();
        }
        return (arg).$to_int();
      }

      for (i = format_string.indexOf('%'); i !== -1; i = format_string.indexOf('%', i)) {
        str = undefined;

        flags = FNONE;
        width = -1;
        precision = -1;
        next_arg = undefined;

        end_slice = i;

        i++;

        switch (format_string.charAt(i)) {
        case '%':
          begin_slice = i;
        case '':
        case '\n':
        case '\0':
          i++;
          continue;
        }

        format_sequence: for (; i < len; i++) {
          switch (format_string.charAt(i)) {

          case ' ':
            CHECK_FOR_FLAGS();
            flags |= FSPACE;
            continue format_sequence;

          case '#':
            CHECK_FOR_FLAGS();
            flags |= FSHARP;
            continue format_sequence;

          case '+':
            CHECK_FOR_FLAGS();
            flags |= FPLUS;
            continue format_sequence;

          case '-':
            CHECK_FOR_FLAGS();
            flags |= FMINUS;
            continue format_sequence;

          case '0':
            CHECK_FOR_FLAGS();
            flags |= FZERO;
            continue format_sequence;

          case '1':
          case '2':
          case '3':
          case '4':
          case '5':
          case '6':
          case '7':
          case '8':
          case '9':
            tmp_num = READ_NUM('width');
            if (format_string.charAt(i + 1) === '$') {
              if (i + 2 === len) {
                str = '%';
                i++;
                break format_sequence;
              }
              if (next_arg !== undefined) {
                self.$raise($scope.get('ArgumentError'), "value given twice - %" + (tmp_num) + "$")
              }
              next_arg = GET_POS_ARG(tmp_num);
              i++;
            } else {
              CHECK_FOR_WIDTH();
              flags |= FWIDTH;
              width = tmp_num;
            }
            continue format_sequence;

          case '<':
          case '\{':
            closing_brace_char = (format_string.charAt(i) === '<' ? '>' : '\}');
            hash_parameter_key = '';

            i++;

            for (;; i++) {
              if (i === len) {
                self.$raise($scope.get('ArgumentError'), "malformed name - unmatched parenthesis")
              }
              if (format_string.charAt(i) === closing_brace_char) {

                if (pos_arg_num > 0) {
                  self.$raise($scope.get('ArgumentError'), "named " + (hash_parameter_key) + " after unnumbered(" + (pos_arg_num) + ")")
                }
                if (pos_arg_num === -1) {
                  self.$raise($scope.get('ArgumentError'), "named " + (hash_parameter_key) + " after numbered")
                }
                pos_arg_num = -2;

                if (args[0] === undefined || !args[0].$$is_hash) {
                  self.$raise($scope.get('ArgumentError'), "one hash required")
                }

                next_arg = (args[0]).$fetch(hash_parameter_key);

                if (closing_brace_char === '>') {
                  continue format_sequence;
                } else {
                  str = next_arg.toString();
                  if (precision !== -1) { str = str.slice(0, precision); }
                  if (flags&FMINUS) {
                    while (str.length < width) { str = str + ' '; }
                  } else {
                    while (str.length < width) { str = ' ' + str; }
                  }
                  break format_sequence;
                }
              }
              hash_parameter_key += format_string.charAt(i);
            }

          case '*':
            i++;
            CHECK_FOR_WIDTH();
            flags |= FWIDTH;
            width = READ_NUM_AFTER_ASTER('width');
            if (width < 0) {
              flags |= FMINUS;
              width = -width;
            }
            continue format_sequence;

          case '.':
            if (flags&FPREC0) {
              self.$raise($scope.get('ArgumentError'), "precision given twice")
            }
            flags |= FPREC|FPREC0;
            precision = 0;
            i++;
            if (format_string.charAt(i) === '*') {
              i++;
              precision = READ_NUM_AFTER_ASTER('precision');
              if (precision < 0) {
                flags &= ~FPREC;
              }
              continue format_sequence;
            }
            precision = READ_NUM('precision');
            continue format_sequence;

          case 'd':
          case 'i':
          case 'u':
            arg = self.$Integer(GET_ARG());
            if (arg >= 0) {
              str = arg.toString();
              while (str.length < precision) { str = '0' + str; }
              if (flags&FMINUS) {
                if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && precision === -1) {
                  while (str.length < width - ((flags&FPLUS || flags&FSPACE) ? 1 : 0)) { str = '0' + str; }
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                } else {
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            } else {
              str = (-arg).toString();
              while (str.length < precision) { str = '0' + str; }
              if (flags&FMINUS) {
                str = '-' + str;
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && precision === -1) {
                  while (str.length < width - 1) { str = '0' + str; }
                  str = '-' + str;
                } else {
                  str = '-' + str;
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            }
            break format_sequence;

          case 'b':
          case 'B':
          case 'o':
          case 'x':
          case 'X':
            switch (format_string.charAt(i)) {
            case 'b':
            case 'B':
              base_number = 2;
              base_prefix = '0b';
              base_neg_zero_regex = /^1+/;
              base_neg_zero_digit = '1';
              break;
            case 'o':
              base_number = 8;
              base_prefix = '0';
              base_neg_zero_regex = /^3?7+/;
              base_neg_zero_digit = '7';
              break;
            case 'x':
            case 'X':
              base_number = 16;
              base_prefix = '0x';
              base_neg_zero_regex = /^f+/;
              base_neg_zero_digit = 'f';
              break;
            }
            arg = self.$Integer(GET_ARG());
            if (arg >= 0) {
              str = arg.toString(base_number);
              while (str.length < precision) { str = '0' + str; }
              if (flags&FMINUS) {
                if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                if (flags&FSHARP && arg !== 0) { str = base_prefix + str; }
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && precision === -1) {
                  while (str.length < width - ((flags&FPLUS || flags&FSPACE) ? 1 : 0) - ((flags&FSHARP && arg !== 0) ? base_prefix.length : 0)) { str = '0' + str; }
                  if (flags&FSHARP && arg !== 0) { str = base_prefix + str; }
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                } else {
                  if (flags&FSHARP && arg !== 0) { str = base_prefix + str; }
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            } else {
              if (flags&FPLUS || flags&FSPACE) {
                str = (-arg).toString(base_number);
                while (str.length < precision) { str = '0' + str; }
                if (flags&FMINUS) {
                  if (flags&FSHARP) { str = base_prefix + str; }
                  str = '-' + str;
                  while (str.length < width) { str = str + ' '; }
                } else {
                  if (flags&FZERO && precision === -1) {
                    while (str.length < width - 1 - (flags&FSHARP ? 2 : 0)) { str = '0' + str; }
                    if (flags&FSHARP) { str = base_prefix + str; }
                    str = '-' + str;
                  } else {
                    if (flags&FSHARP) { str = base_prefix + str; }
                    str = '-' + str;
                    while (str.length < width) { str = ' ' + str; }
                  }
                }
              } else {
                str = (arg >>> 0).toString(base_number).replace(base_neg_zero_regex, base_neg_zero_digit);
                while (str.length < precision - 2) { str = base_neg_zero_digit + str; }
                if (flags&FMINUS) {
                  str = '..' + str;
                  if (flags&FSHARP) { str = base_prefix + str; }
                  while (str.length < width) { str = str + ' '; }
                } else {
                  if (flags&FZERO && precision === -1) {
                    while (str.length < width - 2 - (flags&FSHARP ? base_prefix.length : 0)) { str = base_neg_zero_digit + str; }
                    str = '..' + str;
                    if (flags&FSHARP) { str = base_prefix + str; }
                  } else {
                    str = '..' + str;
                    if (flags&FSHARP) { str = base_prefix + str; }
                    while (str.length < width) { str = ' ' + str; }
                  }
                }
              }
            }
            if (format_string.charAt(i) === format_string.charAt(i).toUpperCase()) {
              str = str.toUpperCase();
            }
            break format_sequence;

          case 'f':
          case 'e':
          case 'E':
          case 'g':
          case 'G':
            arg = self.$Float(GET_ARG());
            if (arg >= 0 || isNaN(arg)) {
              if (arg === Infinity) {
                str = 'Inf';
              } else {
                switch (format_string.charAt(i)) {
                case 'f':
                  str = arg.toFixed(precision === -1 ? 6 : precision);
                  break;
                case 'e':
                case 'E':
                  str = arg.toExponential(precision === -1 ? 6 : precision);
                  break;
                case 'g':
                case 'G':
                  str = arg.toExponential();
                  exponent = parseInt(str.split('e')[1]);
                  if (!(exponent < -4 || exponent >= (precision === -1 ? 6 : precision))) {
                    str = arg.toPrecision(precision === -1 ? (flags&FSHARP ? 6 : undefined) : precision);
                  }
                  break;
                }
              }
              if (flags&FMINUS) {
                if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && arg !== Infinity && !isNaN(arg)) {
                  while (str.length < width - ((flags&FPLUS || flags&FSPACE) ? 1 : 0)) { str = '0' + str; }
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                } else {
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            } else {
              if (arg === -Infinity) {
                str = 'Inf';
              } else {
                switch (format_string.charAt(i)) {
                case 'f':
                  str = (-arg).toFixed(precision === -1 ? 6 : precision);
                  break;
                case 'e':
                case 'E':
                  str = (-arg).toExponential(precision === -1 ? 6 : precision);
                  break;
                case 'g':
                case 'G':
                  str = (-arg).toExponential();
                  exponent = parseInt(str.split('e')[1]);
                  if (!(exponent < -4 || exponent >= (precision === -1 ? 6 : precision))) {
                    str = (-arg).toPrecision(precision === -1 ? (flags&FSHARP ? 6 : undefined) : precision);
                  }
                  break;
                }
              }
              if (flags&FMINUS) {
                str = '-' + str;
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && arg !== -Infinity) {
                  while (str.length < width - 1) { str = '0' + str; }
                  str = '-' + str;
                } else {
                  str = '-' + str;
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            }
            if (format_string.charAt(i) === format_string.charAt(i).toUpperCase() && arg !== Infinity && arg !== -Infinity && !isNaN(arg)) {
              str = str.toUpperCase();
            }
            str = str.replace(/([eE][-+]?)([0-9])$/, '$10$2');
            break format_sequence;

          case 'a':
          case 'A':
            // Not implemented because there are no specs for this field type.
            self.$raise($scope.get('NotImplementedError'), "`A` and `a` format field types are not implemented in Opal yet")

          case 'c':
            arg = GET_ARG();
            if ((arg)['$respond_to?']("to_ary")) { arg = (arg).$to_ary()[0]; }
            if ((arg)['$respond_to?']("to_str")) {
              str = (arg).$to_str();
            } else {
              str = String.fromCharCode($scope.get('Opal').$coerce_to(arg, $scope.get('Integer'), "to_int"));
            }
            if (str.length !== 1) {
              self.$raise($scope.get('ArgumentError'), "%c requires a character")
            }
            if (flags&FMINUS) {
              while (str.length < width) { str = str + ' '; }
            } else {
              while (str.length < width) { str = ' ' + str; }
            }
            break format_sequence;

          case 'p':
            str = (GET_ARG()).$inspect();
            if (precision !== -1) { str = str.slice(0, precision); }
            if (flags&FMINUS) {
              while (str.length < width) { str = str + ' '; }
            } else {
              while (str.length < width) { str = ' ' + str; }
            }
            break format_sequence;

          case 's':
            str = (GET_ARG()).$to_s();
            if (precision !== -1) { str = str.slice(0, precision); }
            if (flags&FMINUS) {
              while (str.length < width) { str = str + ' '; }
            } else {
              while (str.length < width) { str = ' ' + str; }
            }
            break format_sequence;

          default:
            self.$raise($scope.get('ArgumentError'), "malformed format string - %" + (format_string.charAt(i)))
          }
        }

        if (str === undefined) {
          self.$raise($scope.get('ArgumentError'), "malformed format string - %")
        }

        result += format_string.slice(begin_slice, end_slice) + str;
        begin_slice = i + 1;
      }

      if ($gvars.DEBUG && pos_arg_num >= 0 && seq_arg_num < args.length) {
        self.$raise($scope.get('ArgumentError'), "too many arguments for format string")
      }

      return result + format_string.slice(begin_slice);
    ;
    });

    Opal.defn(self, '$freeze', function() {
      var self = this;

      self.___frozen___ = true;
      return self;
    });

    Opal.defn(self, '$frozen?', function() {
      var $a, self = this;
      if (self.___frozen___ == null) self.___frozen___ = nil;

      return ((($a = self.___frozen___) !== false && $a !== nil) ? $a : false);
    });

    Opal.defn(self, '$hash', function() {
      var self = this;

      return "" + (self.$class()) + ":" + (self.$class().$__id__()) + ":" + (self.$__id__());
    });

    Opal.defn(self, '$initialize_copy', function(other) {
      var self = this;

      return nil;
    });

    Opal.defn(self, '$inspect', function() {
      var self = this;

      return self.$to_s();
    });

    Opal.defn(self, '$instance_of?', function(klass) {
      var self = this;

      return self.$$class === klass;
    });

    Opal.defn(self, '$instance_variable_defined?', function(name) {
      var self = this;

      return Opal.hasOwnProperty.call(self, name.substr(1));
    });

    Opal.defn(self, '$instance_variable_get', function(name) {
      var self = this;

      
      var ivar = self[name.substr(1)];

      return ivar == null ? nil : ivar;
    
    });

    Opal.defn(self, '$instance_variable_set', function(name, value) {
      var self = this;

      return self[name.substr(1)] = value;
    });

    Opal.defn(self, '$instance_variables', function() {
      var self = this;

      
      var result = [];

      for (var name in self) {
        if (name.charAt(0) !== '$') {
          if (name !== '$$class' && name !== '$$id') {
            result.push('@' + name);
          }
        }
      }

      return result;
    
    });

    Opal.defn(self, '$Integer', function(value, base) {
      var self = this;

      
      var i, str, base_digits;

      if (!value.$$is_string) {
        if (base !== undefined) {
          self.$raise($scope.get('ArgumentError'), "base specified for non string value")
        }
        if (value === nil) {
          self.$raise($scope.get('TypeError'), "can't convert nil into Integer")
        }
        if (value.$$is_number) {
          if (value === Infinity || value === -Infinity || isNaN(value)) {
            self.$raise($scope.get('FloatDomainError'), value)
          }
          return Math.floor(value);
        }
        if (value['$respond_to?']("to_int")) {
          i = value.$to_int();
          if (i !== nil) {
            return i;
          }
        }
        return $scope.get('Opal')['$coerce_to!'](value, $scope.get('Integer'), "to_i");
      }

      if (base === undefined) {
        base = 0;
      } else {
        base = $scope.get('Opal').$coerce_to(base, $scope.get('Integer'), "to_int");
        if (base === 1 || base < 0 || base > 36) {
          self.$raise($scope.get('ArgumentError'), "invalid radix " + (base))
        }
      }

      str = value.toLowerCase();

      str = str.replace(/(\d)_(?=\d)/g, '$1');

      str = str.replace(/^(\s*[+-]?)(0[bodx]?)/, function (_, head, flag) {
        switch (flag) {
        case '0b':
          if (base === 0 || base === 2) {
            base = 2;
            return head;
          }
        case '0':
        case '0o':
          if (base === 0 || base === 8) {
            base = 8;
            return head;
          }
        case '0d':
          if (base === 0 || base === 10) {
            base = 10;
            return head;
          }
        case '0x':
          if (base === 0 || base === 16) {
            base = 16;
            return head;
          }
        }
        self.$raise($scope.get('ArgumentError'), "invalid value for Integer(): \"" + (value) + "\"")
      });

      base = (base === 0 ? 10 : base);

      base_digits = '0-' + (base <= 10 ? base - 1 : '9a-' + String.fromCharCode(97 + (base - 11)));

      if (!(new RegExp('^\\s*[+-]?[' + base_digits + ']+\\s*$')).test(str)) {
        self.$raise($scope.get('ArgumentError'), "invalid value for Integer(): \"" + (value) + "\"")
      }

      i = parseInt(str, base);

      if (isNaN(i)) {
        self.$raise($scope.get('ArgumentError'), "invalid value for Integer(): \"" + (value) + "\"")
      }

      return i;
    ;
    });

    Opal.defn(self, '$Float', function(value) {
      var self = this;

      
      var str;

      if (value === nil) {
        self.$raise($scope.get('TypeError'), "can't convert nil into Float")
      }

      if (value.$$is_string) {
        str = value.toString();

        str = str.replace(/(\d)_(?=\d)/g, '$1');

        //Special case for hex strings only:
        if (/^\s*[-+]?0[xX][0-9a-fA-F]+\s*$/.test(str)) {
          return self.$Integer(str);
        }

        if (!/^\s*[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?\s*$/.test(str)) {
          self.$raise($scope.get('ArgumentError'), "invalid value for Float(): \"" + (value) + "\"")
        }

        return parseFloat(str);
      }

      return $scope.get('Opal')['$coerce_to!'](value, $scope.get('Float'), "to_f");
    
    });

    Opal.defn(self, '$Hash', function(arg) {
      var $a, $b, self = this;

      if ((($a = ((($b = arg['$nil?']()) !== false && $b !== nil) ? $b : arg['$==']([]))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return $hash2([], {})};
      if ((($a = $scope.get('Hash')['$==='](arg)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return arg};
      return $scope.get('Opal')['$coerce_to!'](arg, $scope.get('Hash'), "to_hash");
    });

    Opal.defn(self, '$is_a?', function(klass) {
      var self = this;

      return Opal.is_a(self, klass);
    });

    Opal.defn(self, '$kind_of?', def['$is_a?']);

    Opal.defn(self, '$lambda', TMP_5 = function() {
      var self = this, $iter = TMP_5.$$p, block = $iter || nil;

      TMP_5.$$p = null;
      block.$$is_lambda = true;
      return block;
    });

    Opal.defn(self, '$load', function(file) {
      var self = this;

      file = $scope.get('Opal')['$coerce_to!'](file, $scope.get('String'), "to_str");
      return Opal.load(Opal.normalize_loadable_path(file));
    });

    Opal.defn(self, '$loop', TMP_6 = function() {
      var self = this, $iter = TMP_6.$$p, block = $iter || nil;

      TMP_6.$$p = null;
      
      while (true) {
        if (block() === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    });

    Opal.defn(self, '$nil?', function() {
      var self = this;

      return false;
    });

    Opal.defn(self, '$object_id', def.$__id__);

    Opal.defn(self, '$printf', function(args) {
      var $a, self = this;

      args = $slice.call(arguments, 0);
      if ($rb_gt(args.$length(), 0)) {
        self.$print(($a = self).$format.apply($a, [].concat(args)))};
      return nil;
    });

    Opal.defn(self, '$private_methods', function() {
      var self = this;

      return [];
    });

    Opal.defn(self, '$private_instance_methods', def.$private_methods);

    Opal.defn(self, '$proc', TMP_7 = function() {
      var self = this, $iter = TMP_7.$$p, block = $iter || nil;

      TMP_7.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        self.$raise($scope.get('ArgumentError'), "tried to create Proc object without a block")
      };
      block.$$is_lambda = false;
      return block;
    });

    Opal.defn(self, '$puts', function(strs) {
      var $a, self = this;
      if ($gvars.stdout == null) $gvars.stdout = nil;

      strs = $slice.call(arguments, 0);
      return ($a = $gvars.stdout).$puts.apply($a, [].concat(strs));
    });

    Opal.defn(self, '$p', function(args) {
      var $a, $b, TMP_8, self = this;

      args = $slice.call(arguments, 0);
      ($a = ($b = args).$each, $a.$$p = (TMP_8 = function(obj){var self = TMP_8.$$s || this;
        if ($gvars.stdout == null) $gvars.stdout = nil;
if (obj == null) obj = nil;
      return $gvars.stdout.$puts(obj.$inspect())}, TMP_8.$$s = self, TMP_8), $a).call($b);
      if ($rb_le(args.$length(), 1)) {
        return args['$[]'](0)
        } else {
        return args
      };
    });

    Opal.defn(self, '$print', function(strs) {
      var $a, self = this;
      if ($gvars.stdout == null) $gvars.stdout = nil;

      strs = $slice.call(arguments, 0);
      return ($a = $gvars.stdout).$print.apply($a, [].concat(strs));
    });

    Opal.defn(self, '$warn', function(strs) {
      var $a, $b, self = this;
      if ($gvars.VERBOSE == null) $gvars.VERBOSE = nil;
      if ($gvars.stderr == null) $gvars.stderr = nil;

      strs = $slice.call(arguments, 0);
      if ((($a = ((($b = $gvars.VERBOSE['$nil?']()) !== false && $b !== nil) ? $b : strs['$empty?']())) !== nil && (!$a.$$is_boolean || $a == true))) {
        return nil
        } else {
        return ($a = $gvars.stderr).$puts.apply($a, [].concat(strs))
      };
    });

    Opal.defn(self, '$raise', function(exception, string) {
      var self = this;
      if ($gvars["!"] == null) $gvars["!"] = nil;

      
      if (exception == null && $gvars["!"]) {
        throw $gvars["!"];
      }

      if (exception == null) {
        exception = $scope.get('RuntimeError').$new();
      }
      else if (exception.$$is_string) {
        exception = $scope.get('RuntimeError').$new(exception);
      }
      else if (exception.$$is_class) {
        exception = exception.$new(string);
      }

      $gvars["!"] = exception;

      throw exception;
    ;
    });

    Opal.defn(self, '$fail', def.$raise);

    Opal.defn(self, '$rand', function(max) {
      var self = this;

      
      if (max === undefined) {
        return Math.random();
      }
      else if (max.$$is_range) {
        var arr = max.$to_a();

        return arr[self.$rand(arr.length)];
      }
      else {
        return Math.floor(Math.random() *
          Math.abs($scope.get('Opal').$coerce_to(max, $scope.get('Integer'), "to_int")));
      }
    
    });

    Opal.defn(self, '$respond_to?', function(name, include_all) {
      var $a, self = this;

      if (include_all == null) {
        include_all = false
      }
      if ((($a = self['$respond_to_missing?'](name)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      
      var body = self['$' + name];

      if (typeof(body) === "function" && !body.$$stub) {
        return true;
      }
    
      return false;
    });

    Opal.defn(self, '$respond_to_missing?', function(method_name) {
      var self = this;

      return false;
    });

    Opal.defn(self, '$require', function(file) {
      var self = this;

      file = $scope.get('Opal')['$coerce_to!'](file, $scope.get('String'), "to_str");
      return Opal.require(Opal.normalize_loadable_path(file));
    });

    Opal.defn(self, '$require_relative', function(file) {
      var self = this;

      $scope.get('Opal')['$try_convert!'](file, $scope.get('String'), "to_str");
      file = $scope.get('File').$expand_path($scope.get('File').$join(Opal.current_file, "..", file));
      return Opal.require(Opal.normalize_loadable_path(file));
    });

    Opal.defn(self, '$require_tree', function(path) {
      var self = this;

      path = $scope.get('File').$expand_path(path);
      if (path['$=='](".")) {
        path = ""};
      
      for (var name in Opal.modules) {
        if ((name)['$start_with?'](path)) {
          Opal.require(name);
        }
      }
    ;
      return nil;
    });

    Opal.defn(self, '$send', def.$__send__);

    Opal.defn(self, '$public_send', def.$__send__);

    Opal.defn(self, '$singleton_class', function() {
      var self = this;

      return Opal.get_singleton_class(self);
    });

    Opal.defn(self, '$sprintf', def.$format);

    Opal.defn(self, '$srand', def.$rand);

    Opal.defn(self, '$String', function(str) {
      var $a, self = this;

      return ((($a = $scope.get('Opal')['$coerce_to?'](str, $scope.get('String'), "to_str")) !== false && $a !== nil) ? $a : $scope.get('Opal')['$coerce_to!'](str, $scope.get('String'), "to_s"));
    });

    Opal.defn(self, '$taint', function() {
      var self = this;

      return self;
    });

    Opal.defn(self, '$tainted?', function() {
      var self = this;

      return false;
    });

    Opal.defn(self, '$tap', TMP_9 = function() {
      var self = this, $iter = TMP_9.$$p, block = $iter || nil;

      TMP_9.$$p = null;
      if (Opal.yield1(block, self) === $breaker) return $breaker.$v;
      return self;
    });

    Opal.defn(self, '$to_proc', function() {
      var self = this;

      return self;
    });

    Opal.defn(self, '$to_s', function() {
      var self = this;

      return "#<" + (self.$class()) + ":0x" + (self.$__id__().$to_s(16)) + ">";
    });

    Opal.defn(self, '$untaint', def.$taint);
  })(self)
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/nil_class"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$raise']);
  (function($base, $super) {
    function $NilClass(){};
    var self = $NilClass = $klass($base, $super, 'NilClass', $NilClass);

    var def = self.$$proto, $scope = self.$$scope;

    def['$!'] = function() {
      var self = this;

      return true;
    };

    def['$&'] = function(other) {
      var self = this;

      return false;
    };

    def['$|'] = function(other) {
      var self = this;

      return other !== false && other !== nil;
    };

    def['$^'] = function(other) {
      var self = this;

      return other !== false && other !== nil;
    };

    def['$=='] = function(other) {
      var self = this;

      return other === nil;
    };

    def.$dup = function() {
      var self = this;

      return self.$raise($scope.get('TypeError'));
    };

    def.$inspect = function() {
      var self = this;

      return "nil";
    };

    def['$nil?'] = function() {
      var self = this;

      return true;
    };

    def.$singleton_class = function() {
      var self = this;

      return $scope.get('NilClass');
    };

    def.$to_a = function() {
      var self = this;

      return [];
    };

    def.$to_h = function() {
      var self = this;

      return Opal.hash();
    };

    def.$to_i = function() {
      var self = this;

      return 0;
    };

    Opal.defn(self, '$to_f', def.$to_i);

    return (def.$to_s = function() {
      var self = this;

      return "";
    }, nil) && 'to_s';
  })(self, null);
  return Opal.cdecl($scope, 'NIL', nil);
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/boolean"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$undef_method']);
  (function($base, $super) {
    function $Boolean(){};
    var self = $Boolean = $klass($base, $super, 'Boolean', $Boolean);

    var def = self.$$proto, $scope = self.$$scope;

    def.$$is_boolean = true;

    def.$__id__ = function() {
      var self = this;

      return self.valueOf() ? 2 : 0;
    };

    Opal.defn(self, '$object_id', def.$__id__);

    (function(self) {
      var $scope = self.$$scope, def = self.$$proto;

      return self.$undef_method("new")
    })(self.$singleton_class());

    def['$!'] = function() {
      var self = this;

      return self != true;
    };

    def['$&'] = function(other) {
      var self = this;

      return (self == true) ? (other !== false && other !== nil) : false;
    };

    def['$|'] = function(other) {
      var self = this;

      return (self == true) ? true : (other !== false && other !== nil);
    };

    def['$^'] = function(other) {
      var self = this;

      return (self == true) ? (other === false || other === nil) : (other !== false && other !== nil);
    };

    def['$=='] = function(other) {
      var self = this;

      return (self == true) === other.valueOf();
    };

    Opal.defn(self, '$equal?', def['$==']);

    Opal.defn(self, '$singleton_class', def.$class);

    return (def.$to_s = function() {
      var self = this;

      return (self == true) ? 'true' : 'false';
    }, nil) && 'to_s';
  })(self, null);
  Opal.cdecl($scope, 'TrueClass', $scope.get('Boolean'));
  Opal.cdecl($scope, 'FalseClass', $scope.get('Boolean'));
  Opal.cdecl($scope, 'TRUE', true);
  return Opal.cdecl($scope, 'FALSE', false);
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/error"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $module = Opal.module;

  Opal.add_stubs(['$attr_reader', '$class']);
  (function($base, $super) {
    function $Exception(){};
    var self = $Exception = $klass($base, $super, 'Exception', $Exception);

    var def = self.$$proto, $scope = self.$$scope;

    def.message = nil;
    self.$attr_reader("message");

    Opal.defs(self, '$new', function(message) {
      var self = this;

      if (message == null) {
        message = "Exception"
      }
      
      var err = new self.$$alloc(message);

      if (Error.captureStackTrace) {
        Error.captureStackTrace(err);
      }

      err.name = self.$$name;
      err.$initialize(message);
      return err;
    
    });

    def.$initialize = function(message) {
      var self = this;

      return self.message = message;
    };

    def.$backtrace = function() {
      var self = this;

      
      var backtrace = self.stack;

      if (typeof(backtrace) === 'string') {
        return backtrace.split("\n").slice(0, 15);
      }
      else if (backtrace) {
        return backtrace.slice(0, 15);
      }

      return [];
    
    };

    def.$inspect = function() {
      var self = this;

      return "#<" + (self.$class()) + ": '" + (self.message) + "'>";
    };

    return Opal.defn(self, '$to_s', def.$message);
  })(self, null);
  (function($base, $super) {
    function $ScriptError(){};
    var self = $ScriptError = $klass($base, $super, 'ScriptError', $ScriptError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Exception'));
  (function($base, $super) {
    function $SyntaxError(){};
    var self = $SyntaxError = $klass($base, $super, 'SyntaxError', $SyntaxError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('ScriptError'));
  (function($base, $super) {
    function $LoadError(){};
    var self = $LoadError = $klass($base, $super, 'LoadError', $LoadError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('ScriptError'));
  (function($base, $super) {
    function $NotImplementedError(){};
    var self = $NotImplementedError = $klass($base, $super, 'NotImplementedError', $NotImplementedError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('ScriptError'));
  (function($base, $super) {
    function $SystemExit(){};
    var self = $SystemExit = $klass($base, $super, 'SystemExit', $SystemExit);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Exception'));
  (function($base, $super) {
    function $NoMemoryError(){};
    var self = $NoMemoryError = $klass($base, $super, 'NoMemoryError', $NoMemoryError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Exception'));
  (function($base, $super) {
    function $SignalException(){};
    var self = $SignalException = $klass($base, $super, 'SignalException', $SignalException);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Exception'));
  (function($base, $super) {
    function $Interrupt(){};
    var self = $Interrupt = $klass($base, $super, 'Interrupt', $Interrupt);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Exception'));
  (function($base, $super) {
    function $StandardError(){};
    var self = $StandardError = $klass($base, $super, 'StandardError', $StandardError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Exception'));
  (function($base, $super) {
    function $NameError(){};
    var self = $NameError = $klass($base, $super, 'NameError', $NameError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $NoMethodError(){};
    var self = $NoMethodError = $klass($base, $super, 'NoMethodError', $NoMethodError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('NameError'));
  (function($base, $super) {
    function $RuntimeError(){};
    var self = $RuntimeError = $klass($base, $super, 'RuntimeError', $RuntimeError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $LocalJumpError(){};
    var self = $LocalJumpError = $klass($base, $super, 'LocalJumpError', $LocalJumpError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $TypeError(){};
    var self = $TypeError = $klass($base, $super, 'TypeError', $TypeError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $ArgumentError(){};
    var self = $ArgumentError = $klass($base, $super, 'ArgumentError', $ArgumentError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $IndexError(){};
    var self = $IndexError = $klass($base, $super, 'IndexError', $IndexError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $StopIteration(){};
    var self = $StopIteration = $klass($base, $super, 'StopIteration', $StopIteration);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('IndexError'));
  (function($base, $super) {
    function $KeyError(){};
    var self = $KeyError = $klass($base, $super, 'KeyError', $KeyError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('IndexError'));
  (function($base, $super) {
    function $RangeError(){};
    var self = $RangeError = $klass($base, $super, 'RangeError', $RangeError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $FloatDomainError(){};
    var self = $FloatDomainError = $klass($base, $super, 'FloatDomainError', $FloatDomainError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('RangeError'));
  (function($base, $super) {
    function $IOError(){};
    var self = $IOError = $klass($base, $super, 'IOError', $IOError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $SystemCallError(){};
    var self = $SystemCallError = $klass($base, $super, 'SystemCallError', $SystemCallError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  return (function($base) {
    var self = $module($base, 'Errno');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $EINVAL(){};
      var self = $EINVAL = $klass($base, $super, 'EINVAL', $EINVAL);

      var def = self.$$proto, $scope = self.$$scope, TMP_1;

      return (Opal.defs(self, '$new', TMP_1 = function() {
        var self = this, $iter = TMP_1.$$p, $yield = $iter || nil;

        TMP_1.$$p = null;
        return Opal.find_super_dispatcher(self, 'new', TMP_1, null, $EINVAL).apply(self, ["Invalid argument"]);
      }), nil) && 'new'
    })(self, $scope.get('SystemCallError'))
  })(self);
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/regexp"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $gvars = Opal.gvars;

  Opal.add_stubs(['$nil?', '$[]', '$raise', '$escape', '$options', '$to_str', '$new', '$join', '$!', '$match', '$begin', '$coerce_to', '$call', '$=~']);
  (function($base, $super) {
    function $RegexpError(){};
    var self = $RegexpError = $klass($base, $super, 'RegexpError', $RegexpError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  return (function($base, $super) {
    function $Regexp(){};
    var self = $Regexp = $klass($base, $super, 'Regexp', $Regexp);

    var def = self.$$proto, $scope = self.$$scope, TMP_1;

    Opal.cdecl($scope, 'IGNORECASE', 1);

    Opal.cdecl($scope, 'MULTILINE', 4);

    def.$$is_regexp = true;

    (function(self) {
      var $scope = self.$$scope, def = self.$$proto;

      self.$$proto.$escape = function(string) {
        var self = this;

        
        return string.replace(/([-[\]\/{}()*+?.^$\\| ])/g, '\\$1')
                     .replace(/[\n]/g, '\\n')
                     .replace(/[\r]/g, '\\r')
                     .replace(/[\f]/g, '\\f')
                     .replace(/[\t]/g, '\\t');
      
      };
      self.$$proto.$last_match = function(n) {
        var $a, self = this;
        if ($gvars["~"] == null) $gvars["~"] = nil;

        if (n == null) {
          n = nil
        }
        if ((($a = n['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          return $gvars["~"]
          } else {
          return $gvars["~"]['$[]'](n)
        };
      };
      self.$$proto.$quote = self.$$proto.$escape;
      self.$$proto.$union = function(parts) {
        var self = this;

        parts = $slice.call(arguments, 0);
        
        var is_first_part_array, quoted_validated, part, options, each_part_options;
        if (parts.length == 0) {
          return /(?!)/;
        }
        // cover the 2 arrays passed as arguments case
        is_first_part_array = parts[0].$$is_array;
        if (parts.length > 1 && is_first_part_array) {
          self.$raise($scope.get('TypeError'), "no implicit conversion of Array into String")
        }        
        // deal with splat issues (related to https://github.com/opal/opal/issues/858)
        if (is_first_part_array) {
          parts = parts[0];
        }
        options = undefined;
        quoted_validated = [];
        for (var i=0; i < parts.length; i++) {
          part = parts[i];
          if (part.$$is_string) {
            quoted_validated.push(self.$escape(part));
          }
          else if (part.$$is_regexp) { 
            each_part_options = (part).$options();   
            if (options != undefined && options != each_part_options) {
              self.$raise($scope.get('TypeError'), "All expressions must use the same options")
            }
            options = each_part_options;
            quoted_validated.push('('+part.source+')');
          }
          else {
            quoted_validated.push(self.$escape((part).$to_str()));
          }
        }
      
        return self.$new((quoted_validated).$join("|"), options);
      };
      return (self.$$proto.$new = function(regexp, options) {
        var self = this;

        
        // Play nice with IE8
        if (regexp.$$is_string && regexp.substr(regexp.length-1, 1) == "\\") {
          self.$raise($scope.get('RegexpError'), "too short escape sequence: /" + (regexp) + "/")
        }
        
        if (options == undefined || options['$!']()) {
          options = undefined;
        }
        
        if (options != undefined) {
          if (regexp.$$is_regexp) {
            // options are already in regex
            options = undefined;
          }
          else if (options.$$is_number) {
            var result = '';
            if ($scope.get('IGNORECASE') & options) {
              result += 'i';
            }
            if ($scope.get('MULTILINE') & options) {
              result += 'm';
            }
            options = result;
          }
          else {
            options = 'i';
          }
        }       
        
        return new RegExp(regexp, options);
      ;
      }, nil) && 'new';
    })(self.$singleton_class());

    def['$=='] = function(other) {
      var self = this;

      return other.constructor == RegExp && self.toString() === other.toString();
    };

    def['$==='] = function(string) {
      var self = this;

      return self.$match(string) !== nil;
    };

    def['$=~'] = function(string) {
      var $a, self = this;
      if ($gvars["~"] == null) $gvars["~"] = nil;

      return ($a = self.$match(string), $a !== false && $a !== nil ?$gvars["~"].$begin(0) : $a);
    };

    Opal.defn(self, '$eql?', def['$==']);

    def.$inspect = function() {
      var self = this;

      return self.toString();
    };

    def.$match = TMP_1 = function(string, pos) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;
      if ($gvars["~"] == null) $gvars["~"] = nil;

      TMP_1.$$p = null;
      
      if (pos === undefined) {
        pos = 0;
      } else {
        pos = $scope.get('Opal').$coerce_to(pos, $scope.get('Integer'), "to_int");
      }

      if (string === nil) {
        return $gvars["~"] = nil;
      }

      string = $scope.get('Opal').$coerce_to(string, $scope.get('String'), "to_str");

      if (pos < 0) {
        pos += string.length;
        if (pos < 0) {
          return $gvars["~"] = nil;
        }
      }

      // global RegExp maintains state, so not using self/this
      var md, re = new RegExp(self.source, 'gm' + (self.ignoreCase ? 'i' : ''));

      while (true) {
        md = re.exec(string);
        if (md === null) {
          return $gvars["~"] = nil;
        }
        if (md.index >= pos) {
          $gvars["~"] = $scope.get('MatchData').$new(re, md)
          return block === nil ? $gvars["~"] : block.$call($gvars["~"]);
        }
        re.lastIndex = md.index + 1;
      }
    ;
    };

    def['$~'] = function() {
      var self = this;
      if ($gvars._ == null) $gvars._ = nil;

      return self['$=~']($gvars._);
    };

    def.$source = function() {
      var self = this;

      return self.source;
    };

    def.$options = function() {
      var self = this;

      
      var as_string, text_flags, result, text_flag;
      as_string = self.toString();
      if (as_string == "/(?:)/") {
        self.$raise($scope.get('TypeError'), "uninitialized Regexp")
      }
      text_flags = as_string.replace(self.source, '').match(/\w+/);
      result = 0;
      // may have no flags
      if (text_flags == null) {
        return result;
      }
      // first match contains all of our flags
      text_flags = text_flags[0];
      for (var i=0; i < text_flags.length; i++) {
        text_flag = text_flags[i];
        switch(text_flag) {
          case 'i':
            result |= $scope.get('IGNORECASE');
            break;
          case 'm':
            result |= $scope.get('MULTILINE');
            break;
          default:
            self.$raise("RegExp flag " + (text_flag) + " does not have a match in Ruby")
        }
      }
      
      return result;
    
    };

    return Opal.defn(self, '$to_s', def.$source);
  })(self, null);
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/comparable"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module;

  Opal.add_stubs(['$===', '$equal?', '$<=>', '$normalize', '$raise', '$class']);
  return (function($base) {
    var self = $module($base, 'Comparable');

    var def = self.$$proto, $scope = self.$$scope;

    Opal.defs(self, '$normalize', function(what) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](what)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return what};
      if ($rb_gt(what, 0)) {
        return 1};
      if ($rb_lt(what, 0)) {
        return -1};
      return 0;
    });

    Opal.defn(self, '$==', function(other) {
      var $a, self = this, cmp = nil;

      try {
      if ((($a = self['$equal?'](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
          return true};
        if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          return false
        };
        return $scope.get('Comparable').$normalize(cmp) == 0;
      } catch ($err) {if (Opal.rescue($err, [$scope.get('StandardError')])) {
        return false
        }else { throw $err; }
      };
    });

    Opal.defn(self, '$>', function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return $scope.get('Comparable').$normalize(cmp) > 0;
    });

    Opal.defn(self, '$>=', function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return $scope.get('Comparable').$normalize(cmp) >= 0;
    });

    Opal.defn(self, '$<', function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return $scope.get('Comparable').$normalize(cmp) < 0;
    });

    Opal.defn(self, '$<=', function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return $scope.get('Comparable').$normalize(cmp) <= 0;
    });

    Opal.defn(self, '$between?', function(min, max) {
      var self = this;

      if ($rb_lt(self, min)) {
        return false};
      if ($rb_gt(self, max)) {
        return false};
      return true;
    });
  })(self)
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/enumerable"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module;

  Opal.add_stubs(['$raise', '$enum_for', '$flatten', '$map', '$==', '$destructure', '$nil?', '$coerce_to!', '$coerce_to', '$===', '$new', '$<<', '$[]', '$[]=', '$inspect', '$__send__', '$yield', '$enumerator_size', '$respond_to?', '$size', '$private', '$compare', '$<=>', '$dup', '$to_a', '$lambda', '$sort', '$call', '$first', '$zip']);
  return (function($base) {
    var self = $module($base, 'Enumerable');

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_22, TMP_23, TMP_24, TMP_25, TMP_26, TMP_27, TMP_28, TMP_29, TMP_30, TMP_31, TMP_32, TMP_33, TMP_35, TMP_37, TMP_41, TMP_42;

    Opal.defn(self, '$all?', TMP_1 = function() {
      var $a, self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      
      var result = true;

      if (block !== nil) {
        self.$each.$$p = function() {
          var value = Opal.yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) === nil || ($a.$$is_boolean && $a == false))) {
            result = false;
            return $breaker;
          }
        };
      }
      else {
        self.$each.$$p = function(obj) {
          if (arguments.length == 1 && (($a = obj) === nil || ($a.$$is_boolean && $a == false))) {
            result = false;
            return $breaker;
          }
        };
      }

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$any?', TMP_2 = function() {
      var $a, self = this, $iter = TMP_2.$$p, block = $iter || nil;

      TMP_2.$$p = null;
      
      var result = false;

      if (block !== nil) {
        self.$each.$$p = function() {
          var value = Opal.yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            result = true;
            return $breaker;
          }
        };
      }
      else {
        self.$each.$$p = function(obj) {
          if (arguments.length != 1 || (($a = obj) !== nil && (!$a.$$is_boolean || $a == true))) {
            result = true;
            return $breaker;
          }
        }
      }

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$chunk', TMP_3 = function(state) {
      var self = this, $iter = TMP_3.$$p, block = $iter || nil;

      TMP_3.$$p = null;
      return self.$raise($scope.get('NotImplementedError'));
    });

    Opal.defn(self, '$collect', TMP_4 = function() {
      var self = this, $iter = TMP_4.$$p, block = $iter || nil;

      TMP_4.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect")
      };
      
      var result = [];

      self.$each.$$p = function() {
        var value = Opal.yieldX(block, arguments);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        result.push(value);
      };

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$collect_concat', TMP_5 = function() {
      var $a, $b, TMP_6, self = this, $iter = TMP_5.$$p, block = $iter || nil;

      TMP_5.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect_concat")
      };
      return ($a = ($b = self).$map, $a.$$p = (TMP_6 = function(item){var self = TMP_6.$$s || this, $a;
if (item == null) item = nil;
      return $a = Opal.yield1(block, item), $a === $breaker ? $a : $a}, TMP_6.$$s = self, TMP_6), $a).call($b).$flatten(1);
    });

    Opal.defn(self, '$count', TMP_7 = function(object) {
      var $a, self = this, $iter = TMP_7.$$p, block = $iter || nil;

      TMP_7.$$p = null;
      
      var result = 0;

      if (object != null) {
        block = function() {
          return $scope.get('Opal').$destructure(arguments)['$=='](object);
        };
      }
      else if (block === nil) {
        block = function() { return true; };
      }

      self.$each.$$p = function() {
        var value = Opal.yieldX(block, arguments);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
          result++;
        }
      }

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$cycle', TMP_8 = function(n) {
      var $a, self = this, $iter = TMP_8.$$p, block = $iter || nil;

      if (n == null) {
        n = nil
      }
      TMP_8.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("cycle", n)
      };
      if ((($a = n['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        n = $scope.get('Opal')['$coerce_to!'](n, $scope.get('Integer'), "to_int");
        if ((($a = n <= 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          return nil};
      };
      
      var result,
          all  = [];

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        all.push(param);
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }

      if (all.length === 0) {
        return nil;
      }
    
      if ((($a = n['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        
        while (true) {
          for (var i = 0, length = all.length; i < length; i++) {
            var value = Opal.yield1(block, all[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }
        }
      
        } else {
        
        while (n > 1) {
          for (var i = 0, length = all.length; i < length; i++) {
            var value = Opal.yield1(block, all[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }

          n--;
        }
      
      };
    });

    Opal.defn(self, '$detect', TMP_9 = function(ifnone) {
      var $a, self = this, $iter = TMP_9.$$p, block = $iter || nil;

      TMP_9.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("detect", ifnone)
      };
      
      var result = undefined;

      self.$each.$$p = function() {
        var params = $scope.get('Opal').$destructure(arguments),
            value  = Opal.yield1(block, params);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
          result = params;
          return $breaker;
        }
      };

      self.$each();

      if (result === undefined && ifnone !== undefined) {
        if (typeof(ifnone) === 'function') {
          result = ifnone();
        }
        else {
          result = ifnone;
        }
      }

      return result === undefined ? nil : result;
    
    });

    Opal.defn(self, '$drop', function(number) {
      var $a, self = this;

      number = $scope.get('Opal').$coerce_to(number, $scope.get('Integer'), "to_int");
      if ((($a = number < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "attempt to drop negative size")};
      
      var result  = [],
          current = 0;

      self.$each.$$p = function() {
        if (number <= current) {
          result.push($scope.get('Opal').$destructure(arguments));
        }

        current++;
      };

      self.$each()

      return result;
    
    });

    Opal.defn(self, '$drop_while', TMP_10 = function() {
      var $a, self = this, $iter = TMP_10.$$p, block = $iter || nil;

      TMP_10.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("drop_while")
      };
      
      var result   = [],
          dropping = true;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments);

        if (dropping) {
          var value = Opal.yield1(block, param);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) === nil || ($a.$$is_boolean && $a == false))) {
            dropping = false;
            result.push(param);
          }
        }
        else {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$each_cons', TMP_11 = function(n) {
      var self = this, $iter = TMP_11.$$p, block = $iter || nil;

      TMP_11.$$p = null;
      return self.$raise($scope.get('NotImplementedError'));
    });

    Opal.defn(self, '$each_entry', TMP_12 = function() {
      var self = this, $iter = TMP_12.$$p, block = $iter || nil;

      TMP_12.$$p = null;
      return self.$raise($scope.get('NotImplementedError'));
    });

    Opal.defn(self, '$each_slice', TMP_13 = function(n) {
      var $a, self = this, $iter = TMP_13.$$p, block = $iter || nil;

      TMP_13.$$p = null;
      n = $scope.get('Opal').$coerce_to(n, $scope.get('Integer'), "to_int");
      if ((($a = n <= 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "invalid slice size")};
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_slice", n)
      };
      
      var result,
          slice = []

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments);

        slice.push(param);

        if (slice.length === n) {
          if (Opal.yield1(block, slice) === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          slice = [];
        }
      };

      self.$each();

      if (result !== undefined) {
        return result;
      }

      // our "last" group, if smaller than n then won't have been yielded
      if (slice.length > 0) {
        if (Opal.yield1(block, slice) === $breaker) {
          return $breaker.$v;
        }
      }
    ;
      return nil;
    });

    Opal.defn(self, '$each_with_index', TMP_14 = function(args) {
      var $a, self = this, $iter = TMP_14.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_14.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = self).$enum_for.apply($a, ["each_with_index"].concat(args))
      };
      
      var result,
          index = 0;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = block(param, index);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        index++;
      };

      self.$each.apply(self, args);

      if (result !== undefined) {
        return result;
      }
    
      return self;
    });

    Opal.defn(self, '$each_with_object', TMP_15 = function(object) {
      var self = this, $iter = TMP_15.$$p, block = $iter || nil;

      TMP_15.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_with_object", object)
      };
      
      var result;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = block(param, object);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }
      };

      self.$each();

      if (result !== undefined) {
        return result;
      }
    
      return object;
    });

    Opal.defn(self, '$entries', function(args) {
      var self = this;

      args = $slice.call(arguments, 0);
      
      var result = [];

      self.$each.$$p = function() {
        result.push($scope.get('Opal').$destructure(arguments));
      };

      self.$each.apply(self, args);

      return result;
    
    });

    Opal.defn(self, '$find', def.$detect);

    Opal.defn(self, '$find_all', TMP_16 = function() {
      var $a, self = this, $iter = TMP_16.$$p, block = $iter || nil;

      TMP_16.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("find_all")
      };
      
      var result = [];

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$find_index', TMP_17 = function(object) {
      var $a, self = this, $iter = TMP_17.$$p, block = $iter || nil;

      TMP_17.$$p = null;
      if ((($a = object === undefined && block === nil) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.$enum_for("find_index")};
      
      var result = nil,
          index  = 0;

      if (object != null) {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments);

          if ((param)['$=='](object)) {
            result = index;
            return $breaker;
          }

          index += 1;
        };
      }
      else if (block !== nil) {
        self.$each.$$p = function() {
          var value = Opal.yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            result = index;
            return $breaker;
          }

          index += 1;
        };
      }

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$first', function(number) {
      var $a, self = this, result = nil;

      if ((($a = number === undefined) !== nil && (!$a.$$is_boolean || $a == true))) {
        result = nil;
        
        self.$each.$$p = function() {
          result = $scope.get('Opal').$destructure(arguments);

          return $breaker;
        };

        self.$each();
      ;
        } else {
        result = [];
        number = $scope.get('Opal').$coerce_to(number, $scope.get('Integer'), "to_int");
        if ((($a = number < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('ArgumentError'), "attempt to take negative size")};
        if ((($a = number == 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          return []};
        
        var current = 0,
            number  = $scope.get('Opal').$coerce_to(number, $scope.get('Integer'), "to_int");

        self.$each.$$p = function() {
          result.push($scope.get('Opal').$destructure(arguments));

          if (number <= ++current) {
            return $breaker;
          }
        };

        self.$each();
      ;
      };
      return result;
    });

    Opal.defn(self, '$flat_map', def.$collect_concat);

    Opal.defn(self, '$grep', TMP_18 = function(pattern) {
      var $a, self = this, $iter = TMP_18.$$p, block = $iter || nil;

      TMP_18.$$p = null;
      
      var result = [];

      if (block !== nil) {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments),
              value = pattern['$==='](param);

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            value = Opal.yield1(block, param);

            if (value === $breaker) {
              result = $breaker.$v;
              return $breaker;
            }

            result.push(value);
          }
        };
      }
      else {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments),
              value = pattern['$==='](param);

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            result.push(param);
          }
        };
      }

      self.$each();

      return result;
    ;
    });

    Opal.defn(self, '$group_by', TMP_19 = function() {
      var $a, $b, $c, self = this, $iter = TMP_19.$$p, block = $iter || nil, hash = nil;

      TMP_19.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("group_by")
      };
      hash = $scope.get('Hash').$new();
      
      var result;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        (($a = value, $b = hash, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, []))))['$<<'](param);
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }
    
      return hash;
    });

    Opal.defn(self, '$include?', function(obj) {
      var self = this;

      
      var result = false;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments);

        if ((param)['$=='](obj)) {
          result = true;
          return $breaker;
        }
      }

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$inject', TMP_20 = function(object, sym) {
      var self = this, $iter = TMP_20.$$p, block = $iter || nil;

      TMP_20.$$p = null;
      
      var result = object;

      if (block !== nil && sym === undefined) {
        self.$each.$$p = function() {
          var value = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = value;
            return;
          }

          value = Opal.yieldX(block, [result, value]);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          result = value;
        };
      }
      else {
        if (sym === undefined) {
          if (!$scope.get('Symbol')['$==='](object)) {
            self.$raise($scope.get('TypeError'), "" + (object.$inspect()) + " is not a Symbol");
          }

          sym    = object;
          result = undefined;
        }

        self.$each.$$p = function() {
          var value = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = value;
            return;
          }

          result = (result).$__send__(sym, value);
        };
      }

      self.$each();

      return result == undefined ? nil : result;
    ;
    });

    Opal.defn(self, '$lazy', function() {
      var $a, $b, TMP_21, self = this;

      return ($a = ($b = (($scope.get('Enumerator')).$$scope.get('Lazy'))).$new, $a.$$p = (TMP_21 = function(enum$, args){var self = TMP_21.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
      return ($a = enum$).$yield.apply($a, [].concat(args))}, TMP_21.$$s = self, TMP_21), $a).call($b, self, self.$enumerator_size());
    });

    Opal.defn(self, '$enumerator_size', function() {
      var $a, self = this;

      if ((($a = self['$respond_to?']("size")) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.$size()
        } else {
        return nil
      };
    });

    self.$private("enumerator_size");

    Opal.defn(self, '$map', def.$collect);

    Opal.defn(self, '$max', TMP_22 = function() {
      var self = this, $iter = TMP_22.$$p, block = $iter || nil;

      TMP_22.$$p = null;
      
      var result;

      if (block !== nil) {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          var value = block(param, result);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if (value === nil) {
            self.$raise($scope.get('ArgumentError'), "comparison failed");
          }

          if (value > 0) {
            result = param;
          }
        };
      }
      else {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          if ($scope.get('Opal').$compare(param, result) > 0) {
            result = param;
          }
        };
      }

      self.$each();

      return result === undefined ? nil : result;
    
    });

    Opal.defn(self, '$max_by', TMP_23 = function() {
      var self = this, $iter = TMP_23.$$p, block = $iter || nil;

      TMP_23.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("max_by")
      };
      
      var result,
          by;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (result === undefined) {
          result = param;
          by     = value;
          return;
        }

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((value)['$<=>'](by) > 0) {
          result = param
          by     = value;
        }
      };

      self.$each();

      return result === undefined ? nil : result;
    
    });

    Opal.defn(self, '$member?', def['$include?']);

    Opal.defn(self, '$min', TMP_24 = function() {
      var self = this, $iter = TMP_24.$$p, block = $iter || nil;

      TMP_24.$$p = null;
      
      var result;

      if (block !== nil) {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          var value = block(param, result);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if (value === nil) {
            self.$raise($scope.get('ArgumentError'), "comparison failed");
          }

          if (value < 0) {
            result = param;
          }
        };
      }
      else {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          if ($scope.get('Opal').$compare(param, result) < 0) {
            result = param;
          }
        };
      }

      self.$each();

      return result === undefined ? nil : result;
    
    });

    Opal.defn(self, '$min_by', TMP_25 = function() {
      var self = this, $iter = TMP_25.$$p, block = $iter || nil;

      TMP_25.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("min_by")
      };
      
      var result,
          by;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (result === undefined) {
          result = param;
          by     = value;
          return;
        }

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((value)['$<=>'](by) < 0) {
          result = param
          by     = value;
        }
      };

      self.$each();

      return result === undefined ? nil : result;
    
    });

    Opal.defn(self, '$minmax', TMP_26 = function() {
      var self = this, $iter = TMP_26.$$p, block = $iter || nil;

      TMP_26.$$p = null;
      return self.$raise($scope.get('NotImplementedError'));
    });

    Opal.defn(self, '$minmax_by', TMP_27 = function() {
      var self = this, $iter = TMP_27.$$p, block = $iter || nil;

      TMP_27.$$p = null;
      return self.$raise($scope.get('NotImplementedError'));
    });

    Opal.defn(self, '$none?', TMP_28 = function() {
      var $a, self = this, $iter = TMP_28.$$p, block = $iter || nil;

      TMP_28.$$p = null;
      
      var result = true;

      if (block !== nil) {
        self.$each.$$p = function() {
          var value = Opal.yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            result = false;
            return $breaker;
          }
        }
      }
      else {
        self.$each.$$p = function() {
          var value = $scope.get('Opal').$destructure(arguments);

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            result = false;
            return $breaker;
          }
        };
      }

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$one?', TMP_29 = function() {
      var $a, self = this, $iter = TMP_29.$$p, block = $iter || nil;

      TMP_29.$$p = null;
      
      var result = false;

      if (block !== nil) {
        self.$each.$$p = function() {
          var value = Opal.yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            if (result === true) {
              result = false;
              return $breaker;
            }

            result = true;
          }
        }
      }
      else {
        self.$each.$$p = function() {
          var value = $scope.get('Opal').$destructure(arguments);

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            if (result === true) {
              result = false;
              return $breaker;
            }

            result = true;
          }
        }
      }

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$partition', TMP_30 = function() {
      var $a, self = this, $iter = TMP_30.$$p, block = $iter || nil;

      TMP_30.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("partition")
      };
      
      var truthy = [], falsy = [], result;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
          truthy.push(param);
        }
        else {
          falsy.push(param);
        }
      };

      self.$each();

      return [truthy, falsy];
    
    });

    Opal.defn(self, '$reduce', def.$inject);

    Opal.defn(self, '$reject', TMP_31 = function() {
      var $a, self = this, $iter = TMP_31.$$p, block = $iter || nil;

      TMP_31.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reject")
      };
      
      var result = [];

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) === nil || ($a.$$is_boolean && $a == false))) {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$reverse_each', TMP_32 = function() {
      var self = this, $iter = TMP_32.$$p, block = $iter || nil;

      TMP_32.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reverse_each")
      };
      
      var result = [];

      self.$each.$$p = function() {
        result.push(arguments);
      };

      self.$each();

      for (var i = result.length - 1; i >= 0; i--) {
        Opal.yieldX(block, result[i]);
      }

      return result;
    
    });

    Opal.defn(self, '$select', def.$find_all);

    Opal.defn(self, '$slice_before', TMP_33 = function(pattern) {
      var $a, $b, TMP_34, self = this, $iter = TMP_33.$$p, block = $iter || nil;

      TMP_33.$$p = null;
      if ((($a = pattern === undefined && block === nil || arguments.length > 1) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 1)")};
      return ($a = ($b = $scope.get('Enumerator')).$new, $a.$$p = (TMP_34 = function(e){var self = TMP_34.$$s || this, $a;
if (e == null) e = nil;
      
        var slice = [];

        if (block !== nil) {
          if (pattern === undefined) {
            self.$each.$$p = function() {
              var param = $scope.get('Opal').$destructure(arguments),
                  value = Opal.yield1(block, param);

              if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true)) && slice.length > 0) {
                e['$<<'](slice);
                slice = [];
              }

              slice.push(param);
            };
          }
          else {
            self.$each.$$p = function() {
              var param = $scope.get('Opal').$destructure(arguments),
                  value = block(param, pattern.$dup());

              if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true)) && slice.length > 0) {
                e['$<<'](slice);
                slice = [];
              }

              slice.push(param);
            };
          }
        }
        else {
          self.$each.$$p = function() {
            var param = $scope.get('Opal').$destructure(arguments),
                value = pattern['$==='](param);

            if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true)) && slice.length > 0) {
              e['$<<'](slice);
              slice = [];
            }

            slice.push(param);
          };
        }

        self.$each();

        if (slice.length > 0) {
          e['$<<'](slice);
        }
      ;}, TMP_34.$$s = self, TMP_34), $a).call($b);
    });

    Opal.defn(self, '$sort', TMP_35 = function() {
      var $a, $b, TMP_36, self = this, $iter = TMP_35.$$p, block = $iter || nil, ary = nil;

      TMP_35.$$p = null;
      ary = self.$to_a();
      if ((block !== nil)) {
        } else {
        block = ($a = ($b = self).$lambda, $a.$$p = (TMP_36 = function(a, b){var self = TMP_36.$$s || this;
if (a == null) a = nil;if (b == null) b = nil;
        return a['$<=>'](b)}, TMP_36.$$s = self, TMP_36), $a).call($b)
      };
      return ary.sort(block);
    });

    Opal.defn(self, '$sort_by', TMP_37 = function() {
      var $a, $b, TMP_38, $c, $d, TMP_39, $e, $f, TMP_40, self = this, $iter = TMP_37.$$p, block = $iter || nil;

      TMP_37.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("sort_by")
      };
      return ($a = ($b = ($c = ($d = ($e = ($f = self).$map, $e.$$p = (TMP_40 = function(){var self = TMP_40.$$s || this, arg = nil;

      arg = $scope.get('Opal').$destructure(arguments);
        return [block.$call(arg), arg];}, TMP_40.$$s = self, TMP_40), $e).call($f)).$sort, $c.$$p = (TMP_39 = function(a, b){var self = TMP_39.$$s || this;
if (a == null) a = nil;if (b == null) b = nil;
      return a['$[]'](0)['$<=>'](b['$[]'](0))}, TMP_39.$$s = self, TMP_39), $c).call($d)).$map, $a.$$p = (TMP_38 = function(arg){var self = TMP_38.$$s || this;
if (arg == null) arg = nil;
      return arg[1];}, TMP_38.$$s = self, TMP_38), $a).call($b);
    });

    Opal.defn(self, '$take', function(num) {
      var self = this;

      return self.$first(num);
    });

    Opal.defn(self, '$take_while', TMP_41 = function() {
      var $a, self = this, $iter = TMP_41.$$p, block = $iter || nil;

      TMP_41.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("take_while")
      };
      
      var result = [];

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) === nil || ($a.$$is_boolean && $a == false))) {
          return $breaker;
        }

        result.push(param);
      };

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$to_a', def.$entries);

    Opal.defn(self, '$zip', TMP_42 = function(others) {
      var $a, self = this, $iter = TMP_42.$$p, block = $iter || nil;

      others = $slice.call(arguments, 0);
      TMP_42.$$p = null;
      return ($a = self.$to_a()).$zip.apply($a, [].concat(others));
    });
  })(self)
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/enumerator"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$allocate', '$new', '$to_proc', '$coerce_to', '$nil?', '$empty?', '$class', '$__send__', '$===', '$call', '$enum_for', '$destructure', '$inspect', '$[]', '$raise', '$yield', '$each', '$enumerator_size', '$respond_to?', '$try_convert', '$for']);
  self.$require("corelib/enumerable");
  return (function($base, $super) {
    function $Enumerator(){};
    var self = $Enumerator = $klass($base, $super, 'Enumerator', $Enumerator);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4;

    def.size = def.args = def.object = def.method = nil;
    self.$include($scope.get('Enumerable'));

    Opal.defs(self, '$for', TMP_1 = function(object, method, args) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      args = $slice.call(arguments, 2);
      if (method == null) {
        method = "each"
      }
      TMP_1.$$p = null;
      
      var obj = self.$allocate();

      obj.object = object;
      obj.size   = block;
      obj.method = method;
      obj.args   = args;

      return obj;
    ;
    });

    def.$initialize = TMP_2 = function() {
      var $a, $b, self = this, $iter = TMP_2.$$p, block = $iter || nil;

      TMP_2.$$p = null;
      if (block !== false && block !== nil) {
        self.object = ($a = ($b = $scope.get('Generator')).$new, $a.$$p = block.$to_proc(), $a).call($b);
        self.method = "each";
        self.args = [];
        self.size = arguments[0] || nil;
        if ((($a = self.size) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self.size = $scope.get('Opal').$coerce_to(self.size, $scope.get('Integer'), "to_int")
          } else {
          return nil
        };
        } else {
        self.object = arguments[0];
        self.method = arguments[1] || "each";
        self.args = $slice.call(arguments, 2);
        return self.size = nil;
      };
    };

    def.$each = TMP_3 = function(args) {
      var $a, $b, $c, self = this, $iter = TMP_3.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_3.$$p = null;
      if ((($a = ($b = block['$nil?'](), $b !== false && $b !== nil ?args['$empty?']() : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self};
      args = $rb_plus(self.args, args);
      if ((($a = block['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        return ($a = self.$class()).$new.apply($a, [self.object, self.method].concat(args))};
      return ($b = ($c = self.object).$__send__, $b.$$p = block.$to_proc(), $b).apply($c, [self.method].concat(args));
    };

    def.$size = function() {
      var $a, self = this;

      if ((($a = $scope.get('Proc')['$==='](self.size)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return ($a = self.size).$call.apply($a, [].concat(self.args))
        } else {
        return self.size
      };
    };

    def.$with_index = TMP_4 = function(offset) {
      var self = this, $iter = TMP_4.$$p, block = $iter || nil;

      if (offset == null) {
        offset = 0
      }
      TMP_4.$$p = null;
      if (offset !== false && offset !== nil) {
        offset = $scope.get('Opal').$coerce_to(offset, $scope.get('Integer'), "to_int")
        } else {
        offset = 0
      };
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("with_index", offset)
      };
      
      var result, index = offset;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = block(param, index);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        index++;
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }

      return self.object;
    
    };

    Opal.defn(self, '$with_object', def.$each_with_object);

    def.$inspect = function() {
      var $a, self = this, result = nil;

      result = "#<" + (self.$class()) + ": " + (self.object.$inspect()) + ":" + (self.method);
      if ((($a = self.args['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        result = $rb_plus(result, "(" + (self.args.$inspect()['$[]']($scope.get('Range').$new(1, -2))) + ")")
      };
      return $rb_plus(result, ">");
    };

    (function($base, $super) {
      function $Generator(){};
      var self = $Generator = $klass($base, $super, 'Generator', $Generator);

      var def = self.$$proto, $scope = self.$$scope, TMP_5, TMP_6;

      def.block = nil;
      self.$include($scope.get('Enumerable'));

      def.$initialize = TMP_5 = function() {
        var self = this, $iter = TMP_5.$$p, block = $iter || nil;

        TMP_5.$$p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise($scope.get('LocalJumpError'), "no block given")
        };
        return self.block = block;
      };

      return (def.$each = TMP_6 = function(args) {
        var $a, $b, self = this, $iter = TMP_6.$$p, block = $iter || nil, yielder = nil;

        args = $slice.call(arguments, 0);
        TMP_6.$$p = null;
        yielder = ($a = ($b = $scope.get('Yielder')).$new, $a.$$p = block.$to_proc(), $a).call($b);
        
        try {
          args.unshift(yielder);

          if (Opal.yieldX(self.block, args) === $breaker) {
            return $breaker.$v;
          }
        }
        catch (e) {
          if (e === $breaker) {
            return $breaker.$v;
          }
          else {
            throw e;
          }
        }
      ;
        return self;
      }, nil) && 'each';
    })(self, null);

    (function($base, $super) {
      function $Yielder(){};
      var self = $Yielder = $klass($base, $super, 'Yielder', $Yielder);

      var def = self.$$proto, $scope = self.$$scope, TMP_7;

      def.block = nil;
      def.$initialize = TMP_7 = function() {
        var self = this, $iter = TMP_7.$$p, block = $iter || nil;

        TMP_7.$$p = null;
        return self.block = block;
      };

      def.$yield = function(values) {
        var self = this;

        values = $slice.call(arguments, 0);
        
        var value = Opal.yieldX(self.block, values);

        if (value === $breaker) {
          throw $breaker;
        }

        return value;
      ;
      };

      return (def['$<<'] = function(values) {
        var $a, self = this;

        values = $slice.call(arguments, 0);
        ($a = self).$yield.apply($a, [].concat(values));
        return self;
      }, nil) && '<<';
    })(self, null);

    return (function($base, $super) {
      function $Lazy(){};
      var self = $Lazy = $klass($base, $super, 'Lazy', $Lazy);

      var def = self.$$proto, $scope = self.$$scope, TMP_8, TMP_11, TMP_13, TMP_18, TMP_20, TMP_21, TMP_23, TMP_26, TMP_29;

      def.enumerator = nil;
      (function($base, $super) {
        function $StopLazyError(){};
        var self = $StopLazyError = $klass($base, $super, 'StopLazyError', $StopLazyError);

        var def = self.$$proto, $scope = self.$$scope;

        return nil;
      })(self, $scope.get('Exception'));

      def.$initialize = TMP_8 = function(object, size) {
        var TMP_9, self = this, $iter = TMP_8.$$p, block = $iter || nil;

        if (size == null) {
          size = nil
        }
        TMP_8.$$p = null;
        if ((block !== nil)) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy new without a block")
        };
        self.enumerator = object;
        return Opal.find_super_dispatcher(self, 'initialize', TMP_8, (TMP_9 = function(yielder, each_args){var self = TMP_9.$$s || this, $a, $b, TMP_10;
if (yielder == null) yielder = nil;each_args = $slice.call(arguments, 1);
        try {
          return ($a = ($b = object).$each, $a.$$p = (TMP_10 = function(args){var self = TMP_10.$$s || this;
args = $slice.call(arguments, 0);
            
              args.unshift(yielder);

              if (Opal.yieldX(block, args) === $breaker) {
                return $breaker;
              }
            ;}, TMP_10.$$s = self, TMP_10), $a).apply($b, [].concat(each_args))
          } catch ($err) {if (Opal.rescue($err, [$scope.get('Exception')])) {
            return nil
            }else { throw $err; }
          }}, TMP_9.$$s = self, TMP_9)).apply(self, [size]);
      };

      Opal.defn(self, '$force', def.$to_a);

      def.$lazy = function() {
        var self = this;

        return self;
      };

      def.$collect = TMP_11 = function() {
        var $a, $b, TMP_12, self = this, $iter = TMP_11.$$p, block = $iter || nil;

        TMP_11.$$p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy map without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_12 = function(enum$, args){var self = TMP_12.$$s || this;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = Opal.yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          enum$.$yield(value);
        }, TMP_12.$$s = self, TMP_12), $a).call($b, self, self.$enumerator_size());
      };

      def.$collect_concat = TMP_13 = function() {
        var $a, $b, TMP_14, self = this, $iter = TMP_13.$$p, block = $iter || nil;

        TMP_13.$$p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy map without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_14 = function(enum$, args){var self = TMP_14.$$s || this, $a, $b, TMP_15, $c, TMP_16;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = Opal.yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((value)['$respond_to?']("force") && (value)['$respond_to?']("each")) {
            ($a = ($b = (value)).$each, $a.$$p = (TMP_15 = function(v){var self = TMP_15.$$s || this;
if (v == null) v = nil;
          return enum$.$yield(v)}, TMP_15.$$s = self, TMP_15), $a).call($b)
          }
          else {
            var array = $scope.get('Opal').$try_convert(value, $scope.get('Array'), "to_ary");

            if (array === nil) {
              enum$.$yield(value);
            }
            else {
              ($a = ($c = (value)).$each, $a.$$p = (TMP_16 = function(v){var self = TMP_16.$$s || this;
if (v == null) v = nil;
          return enum$.$yield(v)}, TMP_16.$$s = self, TMP_16), $a).call($c);
            }
          }
        ;}, TMP_14.$$s = self, TMP_14), $a).call($b, self, nil);
      };

      def.$drop = function(n) {
        var $a, $b, TMP_17, self = this, current_size = nil, set_size = nil, dropped = nil;

        n = $scope.get('Opal').$coerce_to(n, $scope.get('Integer'), "to_int");
        if ($rb_lt(n, 0)) {
          self.$raise($scope.get('ArgumentError'), "attempt to drop negative size")};
        current_size = self.$enumerator_size();
        set_size = (function() {if ((($a = $scope.get('Integer')['$==='](current_size)) !== nil && (!$a.$$is_boolean || $a == true))) {
          if ($rb_lt(n, current_size)) {
            return n
            } else {
            return current_size
          }
          } else {
          return current_size
        }; return nil; })();
        dropped = 0;
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_17 = function(enum$, args){var self = TMP_17.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        if ($rb_lt(dropped, n)) {
            return dropped = $rb_plus(dropped, 1)
            } else {
            return ($a = enum$).$yield.apply($a, [].concat(args))
          }}, TMP_17.$$s = self, TMP_17), $a).call($b, self, set_size);
      };

      def.$drop_while = TMP_18 = function() {
        var $a, $b, TMP_19, self = this, $iter = TMP_18.$$p, block = $iter || nil, succeeding = nil;

        TMP_18.$$p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy drop_while without a block")
        };
        succeeding = true;
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_19 = function(enum$, args){var self = TMP_19.$$s || this, $a, $b;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        if (succeeding !== false && succeeding !== nil) {
            
            var value = Opal.yieldX(block, args);

            if (value === $breaker) {
              return $breaker;
            }

            if ((($a = value) === nil || ($a.$$is_boolean && $a == false))) {
              succeeding = false;

              ($a = enum$).$yield.apply($a, [].concat(args));
            }
          
            } else {
            return ($b = enum$).$yield.apply($b, [].concat(args))
          }}, TMP_19.$$s = self, TMP_19), $a).call($b, self, nil);
      };

      def.$enum_for = TMP_20 = function(method, args) {
        var $a, $b, self = this, $iter = TMP_20.$$p, block = $iter || nil;

        args = $slice.call(arguments, 1);
        if (method == null) {
          method = "each"
        }
        TMP_20.$$p = null;
        return ($a = ($b = self.$class()).$for, $a.$$p = block.$to_proc(), $a).apply($b, [self, method].concat(args));
      };

      def.$find_all = TMP_21 = function() {
        var $a, $b, TMP_22, self = this, $iter = TMP_21.$$p, block = $iter || nil;

        TMP_21.$$p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy select without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_22 = function(enum$, args){var self = TMP_22.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = Opal.yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            ($a = enum$).$yield.apply($a, [].concat(args));
          }
        ;}, TMP_22.$$s = self, TMP_22), $a).call($b, self, nil);
      };

      Opal.defn(self, '$flat_map', def.$collect_concat);

      def.$grep = TMP_23 = function(pattern) {
        var $a, $b, TMP_24, $c, TMP_25, self = this, $iter = TMP_23.$$p, block = $iter || nil;

        TMP_23.$$p = null;
        if (block !== false && block !== nil) {
          return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_24 = function(enum$, args){var self = TMP_24.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
          
            var param = $scope.get('Opal').$destructure(args),
                value = pattern['$==='](param);

            if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
              value = Opal.yield1(block, param);

              if (value === $breaker) {
                return $breaker;
              }

              enum$.$yield(Opal.yield1(block, param));
            }
          ;}, TMP_24.$$s = self, TMP_24), $a).call($b, self, nil)
          } else {
          return ($a = ($c = $scope.get('Lazy')).$new, $a.$$p = (TMP_25 = function(enum$, args){var self = TMP_25.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
          
            var param = $scope.get('Opal').$destructure(args),
                value = pattern['$==='](param);

            if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
              enum$.$yield(param);
            }
          ;}, TMP_25.$$s = self, TMP_25), $a).call($c, self, nil)
        };
      };

      Opal.defn(self, '$map', def.$collect);

      Opal.defn(self, '$select', def.$find_all);

      def.$reject = TMP_26 = function() {
        var $a, $b, TMP_27, self = this, $iter = TMP_26.$$p, block = $iter || nil;

        TMP_26.$$p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy reject without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_27 = function(enum$, args){var self = TMP_27.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = Opal.yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((($a = value) === nil || ($a.$$is_boolean && $a == false))) {
            ($a = enum$).$yield.apply($a, [].concat(args));
          }
        ;}, TMP_27.$$s = self, TMP_27), $a).call($b, self, nil);
      };

      def.$take = function(n) {
        var $a, $b, TMP_28, self = this, current_size = nil, set_size = nil, taken = nil;

        n = $scope.get('Opal').$coerce_to(n, $scope.get('Integer'), "to_int");
        if ($rb_lt(n, 0)) {
          self.$raise($scope.get('ArgumentError'), "attempt to take negative size")};
        current_size = self.$enumerator_size();
        set_size = (function() {if ((($a = $scope.get('Integer')['$==='](current_size)) !== nil && (!$a.$$is_boolean || $a == true))) {
          if ($rb_lt(n, current_size)) {
            return n
            } else {
            return current_size
          }
          } else {
          return current_size
        }; return nil; })();
        taken = 0;
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_28 = function(enum$, args){var self = TMP_28.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        if ($rb_lt(taken, n)) {
            ($a = enum$).$yield.apply($a, [].concat(args));
            return taken = $rb_plus(taken, 1);
            } else {
            return self.$raise($scope.get('StopLazyError'))
          }}, TMP_28.$$s = self, TMP_28), $a).call($b, self, set_size);
      };

      def.$take_while = TMP_29 = function() {
        var $a, $b, TMP_30, self = this, $iter = TMP_29.$$p, block = $iter || nil;

        TMP_29.$$p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy take_while without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_30 = function(enum$, args){var self = TMP_30.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = Opal.yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            ($a = enum$).$yield.apply($a, [].concat(args));
          }
          else {
            self.$raise($scope.get('StopLazyError'));
          }
        ;}, TMP_30.$$s = self, TMP_30), $a).call($b, self, nil);
      };

      Opal.defn(self, '$to_enum', def.$enum_for);

      return (def.$inspect = function() {
        var self = this;

        return "#<" + (self.$class()) + ": " + (self.enumerator.$inspect()) + ">";
      }, nil) && 'inspect';
    })(self, self);
  })(self, null);
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/array"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $gvars = Opal.gvars, $range = Opal.range, $hash2 = Opal.hash2;

  Opal.add_stubs(['$require', '$include', '$new', '$class', '$raise', '$===', '$to_a', '$respond_to?', '$to_ary', '$coerce_to', '$coerce_to?', '$==', '$to_str', '$clone', '$hash', '$<=>', '$object_id', '$inspect', '$enum_for', '$empty?', '$nil?', '$coerce_to!', '$initialize_clone', '$initialize_dup', '$replace', '$eql?', '$length', '$begin', '$end', '$exclude_end?', '$flatten', '$__id__', '$[]', '$to_s', '$join', '$delete_if', '$to_proc', '$each', '$reverse', '$frozen?', '$rotate', '$!', '$map', '$rand', '$keep_if', '$shuffle!', '$sort', '$times', '$[]=', '$<<', '$at', '$kind_of?', '$last', '$first', '$upto']);
  self.$require("corelib/enumerable");
  return (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_21, TMP_22, TMP_23, TMP_24, TMP_25, TMP_30;

    def.length = nil;
    self.$include($scope.get('Enumerable'));

    def.$$is_array = true;

    Opal.defs(self, '$[]', function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      return objects;
    });

    def.$initialize = function(args) {
      var $a, self = this;

      args = $slice.call(arguments, 0);
      return ($a = self.$class()).$new.apply($a, [].concat(args));
    };

    Opal.defs(self, '$new', TMP_1 = function(size, obj) {
      var $a, self = this, $iter = TMP_1.$$p, block = $iter || nil;

      if (size == null) {
        size = nil
      }
      if (obj == null) {
        obj = nil
      }
      TMP_1.$$p = null;
      if ((($a = arguments.length > 2) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 0..2)")};
      if ((($a = arguments.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        return []};
      if ((($a = arguments.length === 1) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ((($a = $scope.get('Array')['$==='](size)) !== nil && (!$a.$$is_boolean || $a == true))) {
          return size.$to_a()
        } else if ((($a = size['$respond_to?']("to_ary")) !== nil && (!$a.$$is_boolean || $a == true))) {
          return size.$to_ary()}};
      size = $scope.get('Opal').$coerce_to(size, $scope.get('Integer'), "to_int");
      if ((($a = size < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "negative array size")};
      
      var result = [];

      if (block === nil) {
        for (var i = 0; i < size; i++) {
          result.push(obj);
        }
      }
      else {
        for (var i = 0, value; i < size; i++) {
          value = block(i);

          if (value === $breaker) {
            return $breaker.$v;
          }

          result[i] = value;
        }
      }

      return result;
    
    });

    Opal.defs(self, '$try_convert', function(obj) {
      var self = this;

      return $scope.get('Opal')['$coerce_to?'](obj, $scope.get('Array'), "to_ary");
    });

    def['$&'] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      
      var result = [],
          seen   = {};

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if (!seen[item]) {
          for (var j = 0, length2 = other.length; j < length2; j++) {
            var item2 = other[j];

            if (!seen[item2] && (item)['$=='](item2)) {
              seen[item] = true;
              result.push(item);
            }
          }
        }
      }

      return result;
    
    };

    def['$|'] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      
      var result = [],
          seen   = {};

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if (!seen[item]) {
          seen[item] = true;
          result.push(item);
        }
      }

      for (var i = 0, length = other.length; i < length; i++) {
        var item = other[i];

        if (!seen[item]) {
          seen[item] = true;
          result.push(item);
        }
      }
      return result;
    
    };

    def['$*'] = function(other) {
      var $a, self = this;

      if ((($a = other['$respond_to?']("to_str")) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.join(other.$to_str())};
      if ((($a = other['$respond_to?']("to_int")) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "no implicit conversion of " + (other.$class()) + " into Integer")
      };
      other = $scope.get('Opal').$coerce_to(other, $scope.get('Integer'), "to_int");
      if ((($a = other < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "negative argument")};
      
      var result = [];

      for (var i = 0; i < other; i++) {
        result = result.concat(self);
      }

      return result;
    
    };

    def['$+'] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      return self.concat(other);
    };

    def['$-'] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      if ((($a = self.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        return []};
      if ((($a = other.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.$clone()};
      
      var seen   = {},
          result = [];

      for (var i = 0, length = other.length; i < length; i++) {
        seen[other[i]] = true;
      }

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if (!seen[item]) {
          result.push(item);
        }
      }

      return result;
    
    };

    def['$<<'] = function(object) {
      var self = this;

      self.push(object);
      return self;
    };

    def['$<=>'] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
      } else if ((($a = other['$respond_to?']("to_ary")) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_ary().$to_a()
        } else {
        return nil
      };
      
      if (self.$hash() === other.$hash()) {
        return 0;
      }

      if (self.length != other.length) {
        return (self.length > other.length) ? 1 : -1;
      }

      for (var i = 0, length = self.length; i < length; i++) {
        var tmp = (self[i])['$<=>'](other[i]);

        if (tmp !== 0) {
          return tmp;
        }
      }

      return 0;
    ;
    };

    def['$=='] = function(other) {
      var self = this;

      
      var recursed = {};

      function _eqeq(array, other) {
        var i, length, a, b;

        if (!other.$$is_array) {
          if ($scope.get('Opal')['$respond_to?'](other, "to_ary")) {
            return (other)['$=='](array);
          } else {
            return false;
          }
        }

        other = other.$to_a();

        if (array.length !== other.length) {
          return false;
        }

        recursed[(array).$object_id()] = true;

        for (i = 0, length = array.length; i < length; i++) {
          a = array[i];
          b = other[i];
          if (a.$$is_array) {
            if (b.$$is_array && b.length !== a.length) {
              return false;
            }
            if (!recursed.hasOwnProperty((a).$object_id())) {
              if (!_eqeq(a, b)) {
                return false;
              }
            }
          } else {
            if (!(a)['$=='](b)) {
              return false;
            }
          }
        }

        return true;
      }

      return _eqeq(self, other);
    ;
    };

    def['$[]'] = function(index, length) {
      var $a, self = this;

      if ((($a = $scope.get('Range')['$==='](index)) !== nil && (!$a.$$is_boolean || $a == true))) {
        
        var size    = self.length,
            exclude = index.exclude,
            from    = $scope.get('Opal').$coerce_to(index.begin, $scope.get('Integer'), "to_int"),
            to      = $scope.get('Opal').$coerce_to(index.end, $scope.get('Integer'), "to_int");

        if (from < 0) {
          from += size;

          if (from < 0) {
            return nil;
          }
        }

        if (from > size) {
          return nil;
        }

        if (to < 0) {
          to += size;

          if (to < 0) {
            return [];
          }
        }

        if (!exclude) {
          to += 1;
        }

        return self.slice(from, to);
      ;
        } else {
        index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");
        
        var size = self.length;

        if (index < 0) {
          index += size;

          if (index < 0) {
            return nil;
          }
        }

        if (length === undefined) {
          if (index >= size || index < 0) {
            return nil;
          }

          return self[index];
        }
        else {
          length = $scope.get('Opal').$coerce_to(length, $scope.get('Integer'), "to_int");

          if (length < 0 || index > size || index < 0) {
            return nil;
          }

          return self.slice(index, index + length);
        }
      
      };
    };

    def['$[]='] = function(index, value, extra) {
      var $a, self = this, data = nil, length = nil;

      if ((($a = $scope.get('Range')['$==='](index)) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ((($a = $scope.get('Array')['$==='](value)) !== nil && (!$a.$$is_boolean || $a == true))) {
          data = value.$to_a()
        } else if ((($a = value['$respond_to?']("to_ary")) !== nil && (!$a.$$is_boolean || $a == true))) {
          data = value.$to_ary().$to_a()
          } else {
          data = [value]
        };
        
        var size    = self.length,
            exclude = index.exclude,
            from    = $scope.get('Opal').$coerce_to(index.begin, $scope.get('Integer'), "to_int"),
            to      = $scope.get('Opal').$coerce_to(index.end, $scope.get('Integer'), "to_int");

        if (from < 0) {
          from += size;

          if (from < 0) {
            self.$raise($scope.get('RangeError'), "" + (index.$inspect()) + " out of range");
          }
        }

        if (to < 0) {
          to += size;
        }

        if (!exclude) {
          to += 1;
        }

        if (from > size) {
          for (var i = size; i < from; i++) {
            self[i] = nil;
          }
        }

        if (to < 0) {
          self.splice.apply(self, [from, 0].concat(data));
        }
        else {
          self.splice.apply(self, [from, to - from].concat(data));
        }

        return value;
      ;
        } else {
        if ((($a = extra === undefined) !== nil && (!$a.$$is_boolean || $a == true))) {
          length = 1
          } else {
          length = value;
          value = extra;
          if ((($a = $scope.get('Array')['$==='](value)) !== nil && (!$a.$$is_boolean || $a == true))) {
            data = value.$to_a()
          } else if ((($a = value['$respond_to?']("to_ary")) !== nil && (!$a.$$is_boolean || $a == true))) {
            data = value.$to_ary().$to_a()
            } else {
            data = [value]
          };
        };
        
        var size   = self.length,
            index  = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int"),
            length = $scope.get('Opal').$coerce_to(length, $scope.get('Integer'), "to_int"),
            old;

        if (index < 0) {
          old    = index;
          index += size;

          if (index < 0) {
            self.$raise($scope.get('IndexError'), "index " + (old) + " too small for array; minimum " + (-self.length));
          }
        }

        if (length < 0) {
          self.$raise($scope.get('IndexError'), "negative length (" + (length) + ")")
        }

        if (index > size) {
          for (var i = size; i < index; i++) {
            self[i] = nil;
          }
        }

        if (extra === undefined) {
          self[index] = value;
        }
        else {
          self.splice.apply(self, [index, length].concat(data));
        }

        return value;
      ;
      };
    };

    def.$assoc = function(object) {
      var self = this;

      
      for (var i = 0, length = self.length, item; i < length; i++) {
        if (item = self[i], item.length && (item[0])['$=='](object)) {
          return item;
        }
      }

      return nil;
    
    };

    def.$at = function(index) {
      var self = this;

      index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");
      
      if (index < 0) {
        index += self.length;
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      return self[index];
    
    };

    def.$bsearch = TMP_2 = function() {
      var self = this, $iter = TMP_2.$$p, block = $iter || nil;

      TMP_2.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("bsearch")
      };
      
      var min = 0,
          max = self.length,
          mid,
          val,
          ret,
          smaller = false,
          satisfied = nil;

      while (min < max) {
        mid = min + Math.floor((max - min) / 2);
        val = self[mid];
        ret = block(val);

        if (ret === $breaker) {
          return $breaker.$v;
        }
        else if (ret === true) {
          satisfied = val;
          smaller = true;
        }
        else if (ret === false || ret === nil) {
          smaller = false;
        }
        else if (ret.$$is_number) {
          if (ret === 0) { return val; }
          smaller = (ret < 0);
        }
        else {
          self.$raise($scope.get('TypeError'), "wrong argument type " + ((ret).$class()) + " (must be numeric, true, false or nil)")
        }

        if (smaller) { max = mid; } else { min = mid + 1; }
      }

      return satisfied;
    
    };

    def.$cycle = TMP_3 = function(n) {
      var $a, $b, self = this, $iter = TMP_3.$$p, block = $iter || nil;

      if (n == null) {
        n = nil
      }
      TMP_3.$$p = null;
      if ((($a = ((($b = self['$empty?']()) !== false && $b !== nil) ? $b : n['$=='](0))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return nil};
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("cycle", n)
      };
      if ((($a = n['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        
        while (true) {
          for (var i = 0, length = self.length; i < length; i++) {
            var value = Opal.yield1(block, self[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }
        }
      
        } else {
        n = $scope.get('Opal')['$coerce_to!'](n, $scope.get('Integer'), "to_int");
        
        if (n <= 0) {
          return self;
        }

        while (n > 0) {
          for (var i = 0, length = self.length; i < length; i++) {
            var value = Opal.yield1(block, self[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }

          n--;
        }
      
      };
      return self;
    };

    def.$clear = function() {
      var self = this;

      self.splice(0, self.length);
      return self;
    };

    def.$clone = function() {
      var self = this, copy = nil;

      copy = [];
      copy.$initialize_clone(self);
      return copy;
    };

    def.$dup = function() {
      var self = this, copy = nil;

      copy = [];
      copy.$initialize_dup(self);
      return copy;
    };

    def.$initialize_copy = function(other) {
      var self = this;

      return self.$replace(other);
    };

    def.$collect = TMP_4 = function() {
      var self = this, $iter = TMP_4.$$p, block = $iter || nil;

      TMP_4.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect")
      };
      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.yield1(block, self[i]);

        if (value === $breaker) {
          return $breaker.$v;
        }

        result.push(value);
      }

      return result;
    
    };

    def['$collect!'] = TMP_5 = function() {
      var self = this, $iter = TMP_5.$$p, block = $iter || nil;

      TMP_5.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect!")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.yield1(block, self[i]);

        if (value === $breaker) {
          return $breaker.$v;
        }

        self[i] = value;
      }
    
      return self;
    };

    def.$combination = TMP_6 = function(n) {
      var $a, self = this, $iter = TMP_6.$$p, $yield = $iter || nil, num = nil;

      TMP_6.$$p = null;
      num = $scope.get('Opal')['$coerce_to!'](n, $scope.get('Integer'), "to_int");
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("combination", num)
      };
      
      var i, length, stack, chosen, lev, done, next;

      if (num === 0) {
        ((($a = Opal.yield1($yield, [])) === $breaker) ? $breaker.$v : $a)
      } else if (num === 1) {
        for (i = 0, length = self.length; i < length; i++) {
          ((($a = Opal.yield1($yield, [self[i]])) === $breaker) ? $breaker.$v : $a)
        }
      }
      else if (num === self.length) {
        ((($a = Opal.yield1($yield, self.slice())) === $breaker) ? $breaker.$v : $a)
      }
      else if (num >= 0 && num < self.length) {
        stack = [];
        for (i = 0; i <= num + 1; i++) {
          stack.push(0);
        }

        chosen = [];
        lev = 0;
        done = false;
        stack[0] = -1;

        while (!done) {
          chosen[lev] = self[stack[lev+1]];
          while (lev < num - 1) {
            lev++;
            next = stack[lev+1] = stack[lev] + 1;
            chosen[lev] = self[next];
          }
          ((($a = Opal.yield1($yield, chosen.slice())) === $breaker) ? $breaker.$v : $a)
          lev++;
          do {
            done = (lev === 0);
            stack[lev]++;
            lev--;
          } while ( stack[lev+1] + num === self.length + lev + 1 );
        }
      }
    ;
      return self;
    };

    def.$compact = function() {
      var self = this;

      
      var result = [];

      for (var i = 0, length = self.length, item; i < length; i++) {
        if ((item = self[i]) !== nil) {
          result.push(item);
        }
      }

      return result;
    
    };

    def['$compact!'] = function() {
      var self = this;

      
      var original = self.length;

      for (var i = 0, length = self.length; i < length; i++) {
        if (self[i] === nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      return self.length === original ? nil : self;
    
    };

    def.$concat = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      
      for (var i = 0, length = other.length; i < length; i++) {
        self.push(other[i]);
      }
    
      return self;
    };

    def.$delete = TMP_7 = function(object) {
      var $a, self = this, $iter = TMP_7.$$p, $yield = $iter || nil;

      TMP_7.$$p = null;
      
      var original = self.length;

      for (var i = 0, length = original; i < length; i++) {
        if ((self[i])['$=='](object)) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      if (self.length === original) {
        if (($yield !== nil)) {
          return ((($a = Opal.yieldX($yield, [])) === $breaker) ? $breaker.$v : $a);
        }
        return nil;
      }
      return object;
    ;
    };

    def.$delete_at = function(index) {
      var self = this;

      
      index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");

      if (index < 0) {
        index += self.length;
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      var result = self[index];

      self.splice(index, 1);

      return result;
    ;
    };

    def.$delete_if = TMP_8 = function() {
      var self = this, $iter = TMP_8.$$p, block = $iter || nil;

      TMP_8.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("delete_if")
      };
      
      for (var i = 0, length = self.length, value; i < length; i++) {
        if ((value = block(self[i])) === $breaker) {
          return $breaker.$v;
        }

        if (value !== false && value !== nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }
    
      return self;
    };

    def.$drop = function(number) {
      var self = this;

      
      if (number < 0) {
        self.$raise($scope.get('ArgumentError'))
      }

      return self.slice(number);
    ;
    };

    Opal.defn(self, '$dup', def.$clone);

    def.$each = TMP_9 = function() {
      var self = this, $iter = TMP_9.$$p, block = $iter || nil;

      TMP_9.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.yield1(block, self[i]);

        if (value == $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def.$each_index = TMP_10 = function() {
      var self = this, $iter = TMP_10.$$p, block = $iter || nil;

      TMP_10.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_index")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.yield1(block, i);

        if (value === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def['$empty?'] = function() {
      var self = this;

      return self.length === 0;
    };

    def['$eql?'] = function(other) {
      var self = this;

      
      var recursed = {};

      function _eql(array, other) {
        var i, length, a, b;

        if (!other.$$is_array) {
          return false;
        }

        other = other.$to_a();

        if (array.length !== other.length) {
          return false;
        }

        recursed[(array).$object_id()] = true;

        for (i = 0, length = array.length; i < length; i++) {
          a = array[i];
          b = other[i];
          if (a.$$is_array) {
            if (b.$$is_array && b.length !== a.length) {
              return false;
            }
            if (!recursed.hasOwnProperty((a).$object_id())) {
              if (!_eql(a, b)) {
                return false;
              }
            }
          } else {
            if (!(a)['$eql?'](b)) {
              return false;
            }
          }
        }

        return true;
      }

      return _eql(self, other);
    
    };

    def.$fetch = TMP_11 = function(index, defaults) {
      var self = this, $iter = TMP_11.$$p, block = $iter || nil;

      TMP_11.$$p = null;
      
      var original = index;

      index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");

      if (index < 0) {
        index += self.length;
      }

      if (index >= 0 && index < self.length) {
        return self[index];
      }

      if (block !== nil) {
        return block(original);
      }

      if (defaults != null) {
        return defaults;
      }

      if (self.length === 0) {
        self.$raise($scope.get('IndexError'), "index " + (original) + " outside of array bounds: 0...0")
      }
      else {
        self.$raise($scope.get('IndexError'), "index " + (original) + " outside of array bounds: -" + (self.length) + "..." + (self.length));
      }
    ;
    };

    def.$fill = TMP_12 = function(args) {
      var $a, self = this, $iter = TMP_12.$$p, block = $iter || nil, one = nil, two = nil, obj = nil, left = nil, right = nil;

      args = $slice.call(arguments, 0);
      TMP_12.$$p = null;
      if (block !== false && block !== nil) {
        if ((($a = args.length > 2) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (args.$length()) + " for 0..2)")};
        $a = Opal.to_ary(args), one = ($a[0] == null ? nil : $a[0]), two = ($a[1] == null ? nil : $a[1]);
        } else {
        if ((($a = args.length == 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('ArgumentError'), "wrong number of arguments (0 for 1..3)")
        } else if ((($a = args.length > 3) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (args.$length()) + " for 1..3)")};
        $a = Opal.to_ary(args), obj = ($a[0] == null ? nil : $a[0]), one = ($a[1] == null ? nil : $a[1]), two = ($a[2] == null ? nil : $a[2]);
      };
      if ((($a = $scope.get('Range')['$==='](one)) !== nil && (!$a.$$is_boolean || $a == true))) {
        if (two !== false && two !== nil) {
          self.$raise($scope.get('TypeError'), "length invalid with range")};
        left = $scope.get('Opal').$coerce_to(one.$begin(), $scope.get('Integer'), "to_int");
        if ((($a = left < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          left += self.length;};
        if ((($a = left < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('RangeError'), "" + (one.$inspect()) + " out of range")};
        right = $scope.get('Opal').$coerce_to(one.$end(), $scope.get('Integer'), "to_int");
        if ((($a = right < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          right += self.length;};
        if ((($a = one['$exclude_end?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          right += 1;
        };
        if ((($a = right <= left) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self};
      } else if (one !== false && one !== nil) {
        left = $scope.get('Opal').$coerce_to(one, $scope.get('Integer'), "to_int");
        if ((($a = left < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          left += self.length;};
        if ((($a = left < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          left = 0};
        if (two !== false && two !== nil) {
          right = $scope.get('Opal').$coerce_to(two, $scope.get('Integer'), "to_int");
          if ((($a = right == 0) !== nil && (!$a.$$is_boolean || $a == true))) {
            return self};
          right += left;
          } else {
          right = self.length
        };
        } else {
        left = 0;
        right = self.length;
      };
      if ((($a = left > self.length) !== nil && (!$a.$$is_boolean || $a == true))) {
        
        for (var i = self.length; i < right; i++) {
          self[i] = nil;
        }
      ;};
      if ((($a = right > self.length) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.length = right};
      if (block !== false && block !== nil) {
        
        for (var length = self.length; left < right; left++) {
          var value = block(left);

          if (value === $breaker) {
            return $breaker.$v;
          }

          self[left] = value;
        }
      ;
        } else {
        
        for (var length = self.length; left < right; left++) {
          self[left] = obj;
        }
      ;
      };
      return self;
    };

    def.$first = function(count) {
      var self = this;

      
      if (count == null) {
        return self.length === 0 ? nil : self[0];
      }

      count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");

      if (count < 0) {
        self.$raise($scope.get('ArgumentError'), "negative array size");
      }

      return self.slice(0, count);
    
    };

    def.$flatten = function(level) {
      var self = this;

      
      var object_id = (self).$object_id();

      function _flatten(array, level) {
        var array = (array).$to_a(),
            result = [],
            i, length,
            item, ary;

        for (i = 0, length = array.length; i < length; i++) {
          item = array[i];

          if (!$scope.get('Opal')['$respond_to?'](item, "to_ary")) {
            result.push(item);
            continue;
          }

          ary = (item).$to_ary();

          if (ary === nil) {
            result.push(item);
            continue;
          }

          if (!ary.$$is_array) {
            self.$raise($scope.get('TypeError'));
          }

          if (object_id === (ary).$object_id()) {
            self.$raise($scope.get('ArgumentError'));
          }

          switch (level) {
          case undefined:
            result.push.apply(result, _flatten(ary));
            break;
          case 0:
            result.push(ary);
            break;
          default:
            result.push.apply(result, _flatten(ary, level - 1));
          }
        }
        return result;
      }

      if (level !== undefined) {
        level = $scope.get('Opal').$coerce_to(level, $scope.get('Integer'), "to_int");
      }

      return _flatten(self, level);
    ;
    };

    def['$flatten!'] = function(level) {
      var self = this;

      
      var flattened = self.$flatten(level);

      if (self.length == flattened.length) {
        for (var i = 0, length = self.length; i < length; i++) {
          if (self[i] !== flattened[i]) {
            break;
          }
        }

        if (i == length) {
          return nil;
        }
      }

      self.$replace(flattened);
    ;
      return self;
    };

    def.$hash = function() {
      var self = this;

      
      var hash = ['A'],
          item;
      for (var i = 0, length = self.length; i < length; i++) {
        item = self[i];
        if (item.$$is_array && (self)['$eql?'](item)) {
          hash.push('self');
        } else {
          hash.push(item.$hash());
        }
      }
      return hash.join(',');
    
    };

    def['$include?'] = function(member) {
      var self = this;

      
      for (var i = 0, length = self.length; i < length; i++) {
        if ((self[i])['$=='](member)) {
          return true;
        }
      }

      return false;
    
    };

    def.$index = TMP_13 = function(object) {
      var self = this, $iter = TMP_13.$$p, block = $iter || nil;

      TMP_13.$$p = null;
      
      if (object != null) {
        for (var i = 0, length = self.length; i < length; i++) {
          if ((self[i])['$=='](object)) {
            return i;
          }
        }
      }
      else if (block !== nil) {
        for (var i = 0, length = self.length, value; i < length; i++) {
          if ((value = block(self[i])) === $breaker) {
            return $breaker.$v;
          }

          if (value !== false && value !== nil) {
            return i;
          }
        }
      }
      else {
        return self.$enum_for("index");
      }

      return nil;
    
    };

    def.$insert = function(index, objects) {
      var self = this;

      objects = $slice.call(arguments, 1);
      
      index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");

      if (objects.length > 0) {
        if (index < 0) {
          index += self.length + 1;

          if (index < 0) {
            self.$raise($scope.get('IndexError'), "" + (index) + " is out of bounds");
          }
        }
        if (index > self.length) {
          for (var i = self.length; i < index; i++) {
            self.push(nil);
          }
        }

        self.splice.apply(self, [index, 0].concat(objects));
      }
    ;
      return self;
    };

    def.$inspect = function() {
      var self = this;

      
      var result = [],
          id     = self.$__id__();

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self['$[]'](i);

        if ((item).$__id__() === id) {
          result.push('[...]');
        }
        else {
          result.push((item).$inspect());
        }
      }

      return '[' + result.join(', ') + ']';
    ;
    };

    def.$join = function(sep) {
      var $a, self = this;
      if ($gvars[","] == null) $gvars[","] = nil;

      if (sep == null) {
        sep = nil
      }
      if ((($a = self.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        return ""};
      if ((($a = sep === nil) !== nil && (!$a.$$is_boolean || $a == true))) {
        sep = $gvars[","]};
      
      var result = [];
      var object_id = (self).$object_id();

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if ($scope.get('Opal')['$respond_to?'](item, "to_str")) {
          var tmp = (item).$to_str();

          if (tmp !== nil) {
            result.push((tmp).$to_s());

            continue;
          }
        }

        if ($scope.get('Opal')['$respond_to?'](item, "to_ary")) {
          var tmp = (item).$to_ary();

          if (object_id === (tmp).$object_id()) {
            self.$raise($scope.get('ArgumentError'));
          }

          if (tmp !== nil) {
            result.push((tmp).$join(sep));

            continue;
          }
        }

        if ($scope.get('Opal')['$respond_to?'](item, "to_s")) {
          var tmp = (item).$to_s();

          if (tmp !== nil) {
            result.push(tmp);

            continue;
          }
        }

        self.$raise($scope.get('NoMethodError'), "" + ($scope.get('Opal').$inspect(item)) + " doesn't respond to #to_str, #to_ary or #to_s");
      }

      if (sep === nil) {
        return result.join('');
      }
      else {
        return result.join($scope.get('Opal')['$coerce_to!'](sep, $scope.get('String'), "to_str").$to_s());
      }
    ;
    };

    def.$keep_if = TMP_14 = function() {
      var self = this, $iter = TMP_14.$$p, block = $iter || nil;

      TMP_14.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("keep_if")
      };
      
      for (var i = 0, length = self.length, value; i < length; i++) {
        if ((value = block(self[i])) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }
    
      return self;
    };

    def.$last = function(count) {
      var self = this;

      
      if (count == null) {
        return self.length === 0 ? nil : self[self.length - 1];
      }

      count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");

      if (count < 0) {
        self.$raise($scope.get('ArgumentError'), "negative array size");
      }

      if (count > self.length) {
        count = self.length;
      }

      return self.slice(self.length - count, self.length);
    
    };

    def.$length = function() {
      var self = this;

      return self.length;
    };

    Opal.defn(self, '$map', def.$collect);

    Opal.defn(self, '$map!', def['$collect!']);

    def.$pop = function(count) {
      var $a, self = this;

      if ((($a = count === undefined) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ((($a = self.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          return nil};
        return self.pop();};
      count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");
      if ((($a = count < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "negative array size")};
      if ((($a = self.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        return []};
      if ((($a = count > self.length) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.splice(0, self.length);
        } else {
        return self.splice(self.length - count, self.length);
      };
    };

    def.$product = TMP_15 = function(args) {
      var $a, self = this, $iter = TMP_15.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_15.$$p = null;
      
      var result = (block !== nil) ? null : [],
          n = args.length + 1,
          counters = new Array(n),
          lengths  = new Array(n),
          arrays   = new Array(n),
          i, m, subarray, len, resultlen = 1;

      arrays[0] = self;
      for (i = 1; i < n; i++) {
        arrays[i] = $scope.get('Opal').$coerce_to(args[i - 1], $scope.get('Array'), "to_ary");
      }

      for (i = 0; i < n; i++) {
        len = arrays[i].length;
        if (len === 0) {
          return result || self;
        }
        resultlen *= len;
        if (resultlen > 2147483647) {
          self.$raise($scope.get('RangeError'), "too big to product")
        }
        lengths[i] = len;
        counters[i] = 0;
      }

      outer_loop: for (;;) {
        subarray = [];
        for (i = 0; i < n; i++) {
          subarray.push(arrays[i][counters[i]]);
        }
        if (result) {
          result.push(subarray);
        } else {
          ((($a = Opal.yield1(block, subarray)) === $breaker) ? $breaker.$v : $a)
        }
        m = n - 1;
        counters[m]++;
        while (counters[m] === lengths[m]) {
          counters[m] = 0;
          if (--m < 0) break outer_loop;
          counters[m]++;
        }
      }

      return result || self;
    ;
    };

    def.$push = function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      
      for (var i = 0, length = objects.length; i < length; i++) {
        self.push(objects[i]);
      }
    
      return self;
    };

    def.$rassoc = function(object) {
      var self = this;

      
      for (var i = 0, length = self.length, item; i < length; i++) {
        item = self[i];

        if (item.length && item[1] !== undefined) {
          if ((item[1])['$=='](object)) {
            return item;
          }
        }
      }

      return nil;
    
    };

    def.$reject = TMP_16 = function() {
      var self = this, $iter = TMP_16.$$p, block = $iter || nil;

      TMP_16.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reject")
      };
      
      var result = [];

      for (var i = 0, length = self.length, value; i < length; i++) {
        if ((value = block(self[i])) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          result.push(self[i]);
        }
      }
      return result;
    
    };

    def['$reject!'] = TMP_17 = function() {
      var $a, $b, self = this, $iter = TMP_17.$$p, block = $iter || nil, original = nil;

      TMP_17.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reject!")
      };
      original = self.$length();
      ($a = ($b = self).$delete_if, $a.$$p = block.$to_proc(), $a).call($b);
      if (self.$length()['$=='](original)) {
        return nil
        } else {
        return self
      };
    };

    def.$replace = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      
      self.splice(0, self.length);
      self.push.apply(self, other);
    
      return self;
    };

    def.$reverse = function() {
      var self = this;

      return self.slice(0).reverse();
    };

    def['$reverse!'] = function() {
      var self = this;

      return self.reverse();
    };

    def.$reverse_each = TMP_18 = function() {
      var $a, $b, self = this, $iter = TMP_18.$$p, block = $iter || nil;

      TMP_18.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reverse_each")
      };
      ($a = ($b = self.$reverse()).$each, $a.$$p = block.$to_proc(), $a).call($b);
      return self;
    };

    def.$rindex = TMP_19 = function(object) {
      var self = this, $iter = TMP_19.$$p, block = $iter || nil;

      TMP_19.$$p = null;
      
      if (object != null) {
        for (var i = self.length - 1; i >= 0; i--) {
          if ((self[i])['$=='](object)) {
            return i;
          }
        }
      }
      else if (block !== nil) {
        for (var i = self.length - 1, value; i >= 0; i--) {
          if ((value = block(self[i])) === $breaker) {
            return $breaker.$v;
          }

          if (value !== false && value !== nil) {
            return i;
          }
        }
      }
      else if (object == null) {
        return self.$enum_for("rindex");
      }

      return nil;
    
    };

    def.$rotate = function(n) {
      var self = this;

      if (n == null) {
        n = 1
      }
      n = $scope.get('Opal').$coerce_to(n, $scope.get('Integer'), "to_int");
      
      var ary, idx, firstPart, lastPart;
      
      if (self.length === 1) {
        return self.slice();
      }
      if (self.length === 0) {
        return [];
      }
      
      ary = self.slice();
      idx = n % ary.length;
      
      firstPart = ary.slice(idx);
      lastPart = ary.slice(0, idx);
      return firstPart.concat(lastPart);
    
    };

    def['$rotate!'] = function(cnt) {
      var $a, self = this, ary = nil;

      if (cnt == null) {
        cnt = 1
      }
      if ((($a = self['$frozen?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('RuntimeError'), "can't modify frozen Array")};
      
      if (self.length === 0 || self.length === 1) {
        return self;
      }
    
      cnt = $scope.get('Opal').$coerce_to(cnt, $scope.get('Integer'), "to_int");
      ary = self.$rotate(cnt);
      return self.$replace(ary);
    };

    def.$sample = function(n) {
      var $a, $b, TMP_20, self = this;

      if (n == null) {
        n = nil
      }
      if ((($a = ($b = n['$!'](), $b !== false && $b !== nil ?self['$empty?']() : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return nil};
      if ((($a = (($b = n !== false && n !== nil) ? self['$empty?']() : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return []};
      if (n !== false && n !== nil) {
        return ($a = ($b = ($range(1, n, false))).$map, $a.$$p = (TMP_20 = function(){var self = TMP_20.$$s || this;

        return self['$[]'](self.$rand(self.$length()))}, TMP_20.$$s = self, TMP_20), $a).call($b)
        } else {
        return self['$[]'](self.$rand(self.$length()))
      };
    };

    def.$select = TMP_21 = function() {
      var self = this, $iter = TMP_21.$$p, block = $iter || nil;

      TMP_21.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("select")
      };
      
      var result = [];

      for (var i = 0, length = self.length, item, value; i < length; i++) {
        item = self[i];

        if ((value = Opal.yield1(block, item)) === $breaker) {
          return $breaker.$v;
        }

        if (value !== false && value !== nil) {
          result.push(item);
        }
      }

      return result;
    
    };

    def['$select!'] = TMP_22 = function() {
      var $a, $b, self = this, $iter = TMP_22.$$p, block = $iter || nil;

      TMP_22.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("select!")
      };
      
      var original = self.length;
      ($a = ($b = self).$keep_if, $a.$$p = block.$to_proc(), $a).call($b);
      return self.length === original ? nil : self;
    
    };

    def.$shift = function(count) {
      var $a, self = this;

      if ((($a = count === undefined) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ((($a = self.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          return nil};
        return self.shift();};
      count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");
      if ((($a = count < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "negative array size")};
      if ((($a = self.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        return []};
      return self.splice(0, count);
    };

    Opal.defn(self, '$size', def.$length);

    def.$shuffle = function() {
      var self = this;

      return self.$clone()['$shuffle!']();
    };

    def['$shuffle!'] = function() {
      var self = this;

      
      for (var i = self.length - 1; i > 0; i--) {
        var tmp = self[i],
            j   = Math.floor(Math.random() * (i + 1));

        self[i] = self[j];
        self[j] = tmp;
      }
    
      return self;
    };

    Opal.defn(self, '$slice', def['$[]']);

    def['$slice!'] = function(index, length) {
      var self = this;

      
      if (index < 0) {
        index += self.length;
      }

      if (length != null) {
        return self.splice(index, length);
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      return self.splice(index, 1)[0];
    
    };

    def.$sort = TMP_23 = function() {
      var $a, self = this, $iter = TMP_23.$$p, block = $iter || nil;

      TMP_23.$$p = null;
      if ((($a = self.length > 1) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        return self
      };
      
      if (!(block !== nil)) {
        block = function(a, b) {
          return (a)['$<=>'](b);
        };
      }

      try {
        return self.slice().sort(function(x, y) {
          var ret = block(x, y);

          if (ret === $breaker) {
            throw $breaker;
          }
          else if (ret === nil) {
            self.$raise($scope.get('ArgumentError'), "comparison of " + ((x).$inspect()) + " with " + ((y).$inspect()) + " failed");
          }

          return $rb_gt(ret, 0) ? 1 : ($rb_lt(ret, 0) ? -1 : 0);
        });
      }
      catch (e) {
        if (e === $breaker) {
          return $breaker.$v;
        }
        else {
          throw e;
        }
      }
    ;
    };

    def['$sort!'] = TMP_24 = function() {
      var $a, $b, self = this, $iter = TMP_24.$$p, block = $iter || nil;

      TMP_24.$$p = null;
      
      var result;

      if ((block !== nil)) {
        result = ($a = ($b = (self.slice())).$sort, $a.$$p = block.$to_proc(), $a).call($b);
      }
      else {
        result = (self.slice()).$sort();
      }

      self.length = 0;
      for(var i = 0, length = result.length; i < length; i++) {
        self.push(result[i]);
      }

      return self;
    ;
    };

    def.$take = function(count) {
      var self = this;

      
      if (count < 0) {
        self.$raise($scope.get('ArgumentError'));
      }

      return self.slice(0, count);
    ;
    };

    def.$take_while = TMP_25 = function() {
      var self = this, $iter = TMP_25.$$p, block = $iter || nil;

      TMP_25.$$p = null;
      
      var result = [];

      for (var i = 0, length = self.length, item, value; i < length; i++) {
        item = self[i];

        if ((value = block(item)) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          return result;
        }

        result.push(item);
      }

      return result;
    
    };

    def.$to_a = function() {
      var self = this;

      return self;
    };

    Opal.defn(self, '$to_ary', def.$to_a);

    def.$to_h = function() {
      var self = this;

      
      var i, len = self.length, ary, key, val, hash = $hash2([], {});

      for (i = 0; i < len; i++) {
        ary = $scope.get('Opal')['$coerce_to?'](self[i], $scope.get('Array'), "to_ary");
        if (!ary.$$is_array) {
          self.$raise($scope.get('TypeError'), "wrong element type " + ((ary).$class()) + " at " + (i) + " (expected array)")
        }
        if (ary.length !== 2) {
          self.$raise($scope.get('ArgumentError'), "wrong array length at " + (i) + " (expected 2, was " + ((ary).$length()) + ")")
        }
        key = ary[0];
        val = ary[1];
        hash.$store(key, val);
      }

      return hash;
    ;
    };

    Opal.defn(self, '$to_s', def.$inspect);

    def.$transpose = function() {
      var $a, $b, TMP_26, self = this, result = nil, max = nil;

      if ((($a = self['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        return []};
      result = [];
      max = nil;
      ($a = ($b = self).$each, $a.$$p = (TMP_26 = function(row){var self = TMP_26.$$s || this, $a, $b, TMP_27;
if (row == null) row = nil;
      if ((($a = $scope.get('Array')['$==='](row)) !== nil && (!$a.$$is_boolean || $a == true))) {
          row = row.$to_a()
          } else {
          row = $scope.get('Opal').$coerce_to(row, $scope.get('Array'), "to_ary").$to_a()
        };
        ((($a = max) !== false && $a !== nil) ? $a : max = row.length);
        if ((($a = (row.length)['$=='](max)['$!']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('IndexError'), "element size differs (" + (row.length) + " should be " + (max))};
        return ($a = ($b = (row.length)).$times, $a.$$p = (TMP_27 = function(i){var self = TMP_27.$$s || this, $a, $b, $c, entry = nil;
if (i == null) i = nil;
        entry = (($a = i, $b = result, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, []))));
          return entry['$<<'](row.$at(i));}, TMP_27.$$s = self, TMP_27), $a).call($b);}, TMP_26.$$s = self, TMP_26), $a).call($b);
      return result;
    };

    def.$uniq = function() {
      var self = this;

      
      var result = [],
          seen   = {};

      for (var i = 0, length = self.length, item, hash; i < length; i++) {
        item = self[i];
        hash = item;

        if (!seen[hash]) {
          seen[hash] = true;

          result.push(item);
        }
      }

      return result;
    
    };

    def['$uniq!'] = function() {
      var self = this;

      
      var original = self.length,
          seen     = {};

      for (var i = 0, length = original, item, hash; i < length; i++) {
        item = self[i];
        hash = item;

        if (!seen[hash]) {
          seen[hash] = true;
        }
        else {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      return self.length === original ? nil : self;
    
    };

    def.$unshift = function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      
      for (var i = objects.length - 1; i >= 0; i--) {
        self.unshift(objects[i]);
      }
    
      return self;
    };

    def.$values_at = function(args) {
      var $a, $b, TMP_28, self = this, out = nil;

      args = $slice.call(arguments, 0);
      out = [];
      ($a = ($b = args).$each, $a.$$p = (TMP_28 = function(elem){var self = TMP_28.$$s || this, $a, $b, TMP_29, finish = nil, start = nil, i = nil;
if (elem == null) elem = nil;
      if ((($a = elem['$kind_of?']($scope.get('Range'))) !== nil && (!$a.$$is_boolean || $a == true))) {
          finish = $scope.get('Opal').$coerce_to(elem.$last(), $scope.get('Integer'), "to_int");
          start = $scope.get('Opal').$coerce_to(elem.$first(), $scope.get('Integer'), "to_int");
          
          if (start < 0) {
            start = start + self.length;
            return nil;;
          }
        
          
          if (finish < 0) {
            finish = finish + self.length;
          }
          if (elem['$exclude_end?']()) {
            finish--;
          }
          if (finish < start) {
            return nil;;
          }
        
          return ($a = ($b = start).$upto, $a.$$p = (TMP_29 = function(i){var self = TMP_29.$$s || this;
if (i == null) i = nil;
          return out['$<<'](self.$at(i))}, TMP_29.$$s = self, TMP_29), $a).call($b, finish);
          } else {
          i = $scope.get('Opal').$coerce_to(elem, $scope.get('Integer'), "to_int");
          return out['$<<'](self.$at(i));
        }}, TMP_28.$$s = self, TMP_28), $a).call($b);
      return out;
    };

    return (def.$zip = TMP_30 = function(others) {
      var $a, self = this, $iter = TMP_30.$$p, block = $iter || nil;

      others = $slice.call(arguments, 0);
      TMP_30.$$p = null;
      
      var result = [], size = self.length, part, o, i, j, jj;

      for (j = 0, jj = others.length; j < jj; j++) {
        o = others[j];
        if (!o.$$is_array) {
          others[j] = (((($a = $scope.get('Opal')['$coerce_to?'](o, $scope.get('Array'), "to_ary")) !== false && $a !== nil) ? $a : $scope.get('Opal')['$coerce_to!'](o, $scope.get('Enumerator'), "each"))).$to_a();
        }
      }

      for (i = 0; i < size; i++) {
        part = [self[i]];

        for (j = 0, jj = others.length; j < jj; j++) {
          o = others[j][i];

          if (o == null) {
            o = nil;
          }

          part[j + 1] = o;
        }

        result[i] = part;
      }

      if (block !== nil) {
        for (i = 0; i < size; i++) {
          block(result[i]);
        }

        return nil;
      }

      return result;
    
    }, nil) && 'zip';
  })(self, null);
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/array/inheritance"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$new', '$allocate', '$initialize', '$to_proc', '$__send__', '$clone', '$respond_to?', '$==', '$eql?', '$inspect', '$hash', '$class', '$slice', '$uniq', '$flatten']);
  (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self.$$proto, $scope = self.$$scope;

    return (Opal.defs(self, '$inherited', function(klass) {
      var self = this, replace = nil;

      replace = $scope.get('Class').$new((($scope.get('Array')).$$scope.get('Wrapper')));
      
      klass.$$proto         = replace.$$proto;
      klass.$$proto.$$class = klass;
      klass.$$alloc         = replace.$$alloc;
      klass.$$parent        = (($scope.get('Array')).$$scope.get('Wrapper'));

      klass.$allocate = replace.$allocate;
      klass.$new      = replace.$new;
      klass["$[]"]    = replace["$[]"];
    
    }), nil) && 'inherited'
  })(self, null);
  return (function($base, $super) {
    function $Wrapper(){};
    var self = $Wrapper = $klass($base, $super, 'Wrapper', $Wrapper);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5;

    def.literal = nil;
    def.$$is_array = true;

    Opal.defs(self, '$allocate', TMP_1 = function(array) {
      var self = this, $iter = TMP_1.$$p, $yield = $iter || nil, obj = nil;

      if (array == null) {
        array = []
      }
      TMP_1.$$p = null;
      obj = Opal.find_super_dispatcher(self, 'allocate', TMP_1, null, $Wrapper).apply(self, []);
      obj.literal = array;
      return obj;
    });

    Opal.defs(self, '$new', TMP_2 = function(args) {
      var $a, $b, self = this, $iter = TMP_2.$$p, block = $iter || nil, obj = nil;

      args = $slice.call(arguments, 0);
      TMP_2.$$p = null;
      obj = self.$allocate();
      ($a = ($b = obj).$initialize, $a.$$p = block.$to_proc(), $a).apply($b, [].concat(args));
      return obj;
    });

    Opal.defs(self, '$[]', function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      return self.$allocate(objects);
    });

    def.$initialize = TMP_3 = function(args) {
      var $a, $b, self = this, $iter = TMP_3.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_3.$$p = null;
      return self.literal = ($a = ($b = $scope.get('Array')).$new, $a.$$p = block.$to_proc(), $a).apply($b, [].concat(args));
    };

    def.$method_missing = TMP_4 = function(args) {
      var $a, $b, self = this, $iter = TMP_4.$$p, block = $iter || nil, result = nil;

      args = $slice.call(arguments, 0);
      TMP_4.$$p = null;
      result = ($a = ($b = self.literal).$__send__, $a.$$p = block.$to_proc(), $a).apply($b, [].concat(args));
      if ((($a = result === self.literal) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self
        } else {
        return result
      };
    };

    def.$initialize_copy = function(other) {
      var self = this;

      return self.literal = (other.literal).$clone();
    };

    def['$respond_to?'] = TMP_5 = function(name) {var $zuper = $slice.call(arguments, 0);
      var $a, self = this, $iter = TMP_5.$$p, $yield = $iter || nil;

      TMP_5.$$p = null;
      return ((($a = Opal.find_super_dispatcher(self, 'respond_to?', TMP_5, $iter).apply(self, $zuper)) !== false && $a !== nil) ? $a : self.literal['$respond_to?'](name));
    };

    def['$=='] = function(other) {
      var self = this;

      return self.literal['$=='](other);
    };

    def['$eql?'] = function(other) {
      var self = this;

      return self.literal['$eql?'](other);
    };

    def.$to_a = function() {
      var self = this;

      return self.literal;
    };

    def.$to_ary = function() {
      var self = this;

      return self;
    };

    def.$inspect = function() {
      var self = this;

      return self.literal.$inspect();
    };

    def.$hash = function() {
      var self = this;

      return self.literal.$hash();
    };

    def['$*'] = function(other) {
      var self = this;

      
      var result = $rb_times(self.literal, other);

      if (result.$$is_array) {
        return self.$class().$allocate(result)
      }
      else {
        return result;
      }
    ;
    };

    def['$[]'] = function(index, length) {
      var self = this;

      
      var result = self.literal.$slice(index, length);

      if (result.$$is_array && (index.$$is_range || length !== undefined)) {
        return self.$class().$allocate(result)
      }
      else {
        return result;
      }
    ;
    };

    Opal.defn(self, '$slice', def['$[]']);

    def.$uniq = function() {
      var self = this;

      return self.$class().$allocate(self.literal.$uniq());
    };

    def.$flatten = function(level) {
      var self = this;

      return self.$class().$allocate(self.literal.$flatten(level));
    };

    def['$-'] = function(other) {
      var self = this;

      return $rb_minus(self.literal, other);
    };

    return (def['$+'] = function(other) {
      var self = this;

      return $rb_plus(self.literal, other);
    }, nil) && '+';
  })($scope.get('Array'), null);
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/hash"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$coerce_to?', '$[]', '$merge!', '$allocate', '$raise', '$!', '$==', '$call', '$coerce_to!', '$lambda?', '$abs', '$arity', '$enum_for', '$inspect', '$flatten', '$eql?', '$===', '$clone', '$to_proc', '$alias_method']);
  self.$require("corelib/enumerable");
  return (function($base, $super) {
    function $Hash(){};
    var self = $Hash = $klass($base, $super, 'Hash', $Hash);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13;

    def.proc = def.none = nil;
    self.$include($scope.get('Enumerable'));

    def.$$is_hash = true;

    Opal.defs(self, '$[]', function(argv) {
      var self = this;

      argv = $slice.call(arguments, 0);
      
      var hash, i, argc = argv.length;

      if (argc === 1) {
        hash = $scope.get('Opal')['$coerce_to?'](argv['$[]'](0), $scope.get('Hash'), "to_hash");
        if (hash !== nil) {
          return self.$allocate()['$merge!'](hash);
        }

        argv = $scope.get('Opal')['$coerce_to?'](argv['$[]'](0), $scope.get('Array'), "to_ary");
        if (argv === nil) {
          self.$raise($scope.get('ArgumentError'), "odd number of arguments for Hash")
        }

        argc = argv.length;
        hash = self.$allocate();

        for (i = 0; i < argc; i++) {
          if (!argv[i].$$is_array) continue;
          switch(argv[i].length) {
          case 1:
            hash.$store(argv[i][0], nil);
            break;
          case 2:
            hash.$store(argv[i][0], argv[i][1]);
            break;
          default:
            self.$raise($scope.get('ArgumentError'), "invalid number of elements (" + (argv[i].length) + " for 1..2)")
          }
        }

        return hash;
      }

      if (argc % 2 !== 0) {
        self.$raise($scope.get('ArgumentError'), "odd number of arguments for Hash")
      }

      hash = self.$allocate();

      for (i = 0; i < argc; i += 2) {
        hash.$store(argv[i], argv[i + 1]);
      }

      return hash;
    ;
    });

    Opal.defs(self, '$allocate', function() {
      var self = this;

      
      var hash = new self.$$alloc;

      hash.map  = {};
      hash.smap = {};
      hash.keys = [];
      hash.none = nil;
      hash.proc = nil;

      return hash;
    
    });

    def.$initialize = TMP_1 = function(defaults) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      
      self.none = (defaults === undefined ? nil : defaults);
      self.proc = block;
    
      return self;
    };

    def['$=='] = function(other) {
      var self = this;

      
      if (self === other) {
        return true;
      }

      if (!other.keys || !other.smap || !other.map) {
        return false;
      }

      if (self.keys.length !== other.keys.length) {
        return false;
      }

      var _map  = self.map,
          smap  = self.smap,
          _map2 = other.map,
          smap2 = other.smap,
          map, map2, key, khash, value, value2;

      for (var i = 0, length = self.keys.length; i < length; i++) {
        key = self.keys[i];

        if (key.$$is_string) {
          khash = key;
          map   = smap;
          map2  = smap2;
        } else {
          khash = key.$hash();
          map   = _map;
          map2  = _map2;
        }

        value  = map[khash];
        if (value === undefined) console.log('==', key, self);
        value2 = map2[khash];

        if (value2 === undefined || ((value)['$=='](value2))['$!']()) {
          return false;
        }
      }

      return true;
    
    };

    def['$[]'] = function(key) {
      var self = this;

      
      var map, khash;

      if (key.$$is_string) {
        map = self.smap;
        khash = key;
      } else {
        map = self.map;
        khash = key.$hash();
      }

      if (map === undefined) { console.log(self, '[] --> key:', key, khash, map) }


      if (Opal.hasOwnProperty.call(map, khash)) {
        return map[khash];
      }

      var proc = self.proc;

      if (proc !== nil) {
        return (proc).$call(self, key);
      }

      return self.none;
    
    };

    def['$[]='] = function(key, value) {
      var self = this;

      
      var map, khash, value;

      if (key.$$is_string) {
        map = self.smap;
        khash = key;
      } else {
        map = self.map;
        khash = key.$hash();
      }

      if (!Opal.hasOwnProperty.call(map, khash)) {
        self.keys.push(key);
      }

      map[khash] = value;

      return value;
    
    };

    def.$assoc = function(object) {
      var self = this;

      
      var keys = self.keys,
          map, key, khash;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if ((key)['$=='](object)) {
          if (key.$$is_string) {
            map = self.smap;
            khash = key;
          } else {
            map = self.map;
            khash = key.$hash();
          }

          return [key, map[khash]];
        }
      }

      return nil;
    
    };

    def.$clear = function() {
      var self = this;

      
      self.map = {};
      self.smap = {};
      self.keys = [];
      return self;
    
    };

    def.$clone = function() {
      var self = this;

      
      var _map  = {},
          smap  = {},
          _map2 = self.map,
          smap2 = self.smap,
          keys  = [],
          map, map2, key, khash, value;

      for (var i = 0, length = self.keys.length; i < length; i++) {
        key   = self.keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
          map2 = smap2;
        } else {
          khash = key.$hash();
          map = _map;
          map2 = _map2;
        }

        value = map2[khash];

        keys.push(key);
        map[khash] = value;
      }

      var clone = new self.$$class.$$alloc();

      clone.map  = _map;
      clone.smap = smap;
      clone.keys = keys;
      clone.none = self.none;
      clone.proc = self.proc;

      return clone;
    
    };

    def.$default = function(val) {
      var self = this;

      
      if (val !== undefined && self.proc !== nil) {
        return self.proc.$call(self, val);
      }
      return self.none;
    ;
    };

    def['$default='] = function(object) {
      var self = this;

      
      self.proc = nil;
      return (self.none = object);
    
    };

    def.$default_proc = function() {
      var self = this;

      return self.proc;
    };

    def['$default_proc='] = function(proc) {
      var self = this;

      
      if (proc !== nil) {
        proc = $scope.get('Opal')['$coerce_to!'](proc, $scope.get('Proc'), "to_proc");

        if (proc['$lambda?']() && proc.$arity().$abs() != 2) {
          self.$raise($scope.get('TypeError'), "default_proc takes two arguments");
        }
      }
      self.none = nil;
      return (self.proc = proc);
    ;
    };

    def.$delete = TMP_2 = function(key) {
      var self = this, $iter = TMP_2.$$p, block = $iter || nil;

      TMP_2.$$p = null;
      
      var result, map, khash;

      if (key.$$is_string) {
        map = self.smap;
        khash = key;
      } else {
        map = self.map;
        khash = key.$hash();
      }

      result = map[khash];

      if (result != null) {
        delete map[khash];
        self.keys.$delete(key);

        return result;
      }

      if (block !== nil) {
        return block.$call(key);
      }
      return nil;
    
    };

    def.$delete_if = TMP_3 = function() {
      var self = this, $iter = TMP_3.$$p, block = $iter || nil;

      TMP_3.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("delete_if")
      };
      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys,
          map, key, value, obj, khash;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          map = smap;
          khash = key;
        } else {
          map = _map;
          khash = key.$hash();
        }
        obj = map[khash];
        value = block(key, obj);

        if (value === $breaker) {
          return $breaker.$v;
        }

        if (value !== false && value !== nil) {
          keys.splice(i, 1);
          delete map[khash];

          length--;
          i--;
        }
      }

      return self;
    
    };

    Opal.defn(self, '$dup', def.$clone);

    def.$each = TMP_4 = function() {
      var self = this, $iter = TMP_4.$$p, block = $iter || nil;

      TMP_4.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each")
      };
      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys,
          map, key, khash, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          map = smap;
          khash = key;
        } else {
          map = _map;
          khash = key.$hash();
        }

        value = Opal.yield1(block, [key, map[khash]]);

        if (value === $breaker) {
          return $breaker.$v;
        }
      }

      return self;
    
    };

    def.$each_key = TMP_5 = function() {
      var self = this, $iter = TMP_5.$$p, block = $iter || nil;

      TMP_5.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each_key")
      };
      
      var keys = self.keys, key;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (block(key) === $breaker) {
          return $breaker.$v;
        }
      }

      return self;
    
    };

    Opal.defn(self, '$each_pair', def.$each);

    def.$each_value = TMP_6 = function() {
      var self = this, $iter = TMP_6.$$p, block = $iter || nil;

      TMP_6.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each_value")
      };
      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys, key, map, khash;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          map = smap;
          khash = key;
        } else {
          map = _map;
          khash = key.$hash();
        }

        if (block(map[khash]) === $breaker) {
          return $breaker.$v;
        }
      }

      return self;
    
    };

    def['$empty?'] = function() {
      var self = this;

      return self.keys.length === 0;
    };

    Opal.defn(self, '$eql?', def['$==']);

    def.$fetch = TMP_7 = function(key, defaults) {
      var self = this, $iter = TMP_7.$$p, block = $iter || nil;

      TMP_7.$$p = null;
      
      var map, khash, value;

      if (key.$$is_string) {
        khash = key;
        map = self.smap;
      } else {
        khash = key.$hash();
        map = self.map;
      }

      value = map[khash];

      if (value != null) {
        return value;
      }

      if (block !== nil) {
        var value;

        if ((value = block(key)) === $breaker) {
          return $breaker.$v;
        }

        return value;
      }

      if (defaults != null) {
        return defaults;
      }

      self.$raise($scope.get('KeyError'), "key not found: " + (key.$inspect()));
    
    };

    def.$flatten = function(level) {
      var self = this;

      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys,
          result = [],
          map, key, khash, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        value = map[khash];

        result.push(key);

        if (value.$$is_array) {
          if (level == null || level === 1) {
            result.push(value);
          }
          else {
            result = result.concat((value).$flatten(level - 1));
          }
        }
        else {
          result.push(value);
        }
      }

      return result;
    
    };

    def['$has_key?'] = function(key) {
      var self = this;

      
      var keys = self.keys,
          map, khash;

      if (key.$$is_string) {
        khash = key;
        map = self.smap;
      } else {
        khash = key.$hash();
        map = self.map;
      }

      if (Opal.hasOwnProperty.call(map, khash)) {
        for (var i = 0, length = keys.length; i < length; i++) {
          if (!(key['$eql?'](keys[i]))['$!']()) {
            return true;
          }
        }
      }

      return false;
    
    };

    def['$has_value?'] = function(value) {
      var self = this;

      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys, key, map, khash;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          map = smap;
          khash = key;
        } else {
          map = _map;
          khash = key.$hash();
        }

        if ((map[khash])['$=='](value)) {
          return true;
        }
      }

      return false;
    
    };

    var hash_ids = null;

    def.$hash = function() {
      var self = this;

      
      var top = (hash_ids === null);
      try {
        var key, value,
            hash = ['Hash'],
            keys = self.keys,
            id = self.$object_id(),
            counter = 0;

        if (top) {
          hash_ids = {}
        }

        if (hash_ids.hasOwnProperty(id)) {
          return 'self';
        }

        hash_ids[id] = true;

        for (var i = 0, length = keys.length; i < length; i++) {
          key   = keys[i];
          value = key.$$is_string ? self.smap[key] : self.map[key.$hash()];
          key   = key.$hash();
          value = (typeof(value) === 'undefined') ? '' : value.$hash();
          hash.push([key,value]);
        }

        return hash.sort().join();
      } finally {
        if (top) {
          hash_ids = null;
        }
      }
    
    };

    Opal.defn(self, '$include?', def['$has_key?']);

    def.$index = function(object) {
      var self = this;

      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys,
          map, khash, key;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          map = smap;
          khash = key;
        } else {
          map = _map;
          khash = key.$hash();
        }

        if ((map[khash])['$=='](object)) {
          return key;
        }
      }

      return nil;
    
    };

    def.$indexes = function(keys) {
      var self = this;

      keys = $slice.call(arguments, 0);
      
      var result = [],
          _map = self.map,
          smap = self.smap,
          map, key, khash, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        value = map[khash];

        if (value != null) {
          result.push(value);
        }
        else {
          result.push(self.none);
        }
      }

      return result;
    
    };

    Opal.defn(self, '$indices', def.$indexes);

    var inspect_ids = null;

    def.$inspect = function() {
      var self = this;

      
      var top = (inspect_ids === null);
      try {

        var key, value,
            inspect = [],
            keys = self.keys,
            id = self.$object_id(),
            counter = 0;

        if (top) {
          inspect_ids = {}
        }

        if (inspect_ids.hasOwnProperty(id)) {
          return '{...}';
        }

        inspect_ids[id] = true;

        for (var i = 0, length = keys.length; i < length; i++) {
          key   = keys[i];
          value = key.$$is_string ? self.smap[key] : self.map[key.$hash()];
          key   = key.$inspect();
          value = value.$inspect();
          inspect.push(key + '=>' + value);
        }

        return '{' + inspect.join(', ') + '}';
      } finally {

        if (top) {
          inspect_ids = null;
        }
      }
    
    };

    def.$invert = function() {
      var self = this;

      
      var result = Opal.hash(),
          keys = self.keys,
          _map = self.map,
          smap = self.smap,
          keys2 = result.keys,
          _map2 = result.map,
          smap2 = result.smap,
          map, map2, key, khash, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          map = smap;
          khash = key;
        } else {
          map = _map;
          khash = key.$hash();
        }

        value = map[khash];
        keys2.push(value);

        if (value.$$is_string) {
          map2 = smap2;
          khash = value;
        } else {
          map2 = _map2;
          khash = value.$hash();
        }

        map2[khash] = key;
      }

      return result;
    
    };

    def.$keep_if = TMP_8 = function() {
      var self = this, $iter = TMP_8.$$p, block = $iter || nil;

      TMP_8.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("keep_if")
      };
      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys,
          map, key, khash, value, keep;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        value = map[khash];
        keep  = block(key, value);

        if (keep === $breaker) {
          return $breaker.$v;
        }

        if (keep === false || keep === nil) {
          keys.splice(i, 1);
          delete map[khash];

          length--;
          i--;
        }
      }

      return self;
    
    };

    Opal.defn(self, '$key', def.$index);

    Opal.defn(self, '$key?', def['$has_key?']);

    def.$keys = function() {
      var self = this;

      return self.keys.slice(0);
    };

    def.$length = function() {
      var self = this;

      return self.keys.length;
    };

    Opal.defn(self, '$member?', def['$has_key?']);

    def.$merge = TMP_9 = function(other) {
      var $a, $b, self = this, $iter = TMP_9.$$p, block = $iter || nil, cloned = nil;

      TMP_9.$$p = null;
      if ((($a = $scope.get('Hash')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        other = $scope.get('Opal')['$coerce_to!'](other, $scope.get('Hash'), "to_hash")
      };
      cloned = self.$clone();
      ($a = ($b = cloned)['$merge!'], $a.$$p = block.$to_proc(), $a).call($b, other);
      return cloned;
    };

    def['$merge!'] = TMP_10 = function(other) {
      var self = this, $iter = TMP_10.$$p, block = $iter || nil;

      TMP_10.$$p = null;
      
      if (! $scope.get('Hash')['$==='](other)) {
        other = $scope.get('Opal')['$coerce_to!'](other, $scope.get('Hash'), "to_hash");
      }

      var keys  = self.keys,
          _map  = self.map,
          smap  = self.smap,
          keys2 = other.keys,
          _map2 = other.map,
          smap2 = other.smap,
          map, map2, key, khash, value, value2;

      if (block === nil) {
        for (var i = 0, length = keys2.length; i < length; i++) {
          key = keys2[i];

          if (key.$$is_string) {
            khash = key;
            map = smap;
            map2 = smap2;
          } else {
            khash = key.$hash();
            map = _map;
            map2 = _map2;
          }

          if (map[khash] == null) {
            keys.push(key);
          }

          map[khash] = map2[khash];
        }
      }
      else {
        for (var i = 0, length = keys2.length; i < length; i++) {
          key    = keys2[i];

          if (key.$$is_string) {
            khash = key;
            map = smap;
            map2 = smap2;
          } else {
            khash = key.$hash();
            map = _map;
            map2 = _map2;
          }

          value  = map[khash];
          value2 = map2[khash];

          if (value == null) {
            keys.push(key);
            map[khash] = value2;
          }
          else {
            map[khash] = block(key, value, value2);
          }
        }
      }

      return self;
    ;
    };

    def.$rassoc = function(object) {
      var self = this;

      
      var keys = self.keys,
          _map = self.map,
          smap = self.smap,
          key, khash, value, map;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i]

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        value = map[khash];

        if ((value)['$=='](object)) {
          return [key, value];
        }
      }

      return nil;
    
    };

    def.$reject = TMP_11 = function() {
      var self = this, $iter = TMP_11.$$p, block = $iter || nil;

      TMP_11.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("reject")
      };
      
      var keys   = self.keys,
          _map    = self.map,
          smap    = self.smap,
          result = Opal.hash(),
          _map2   = result.map,
          smap2   = result.smap,
          keys2  = result.keys,
          map, map2, key, khash, object, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
          map2 = smap2;
        } else {
          khash = key.$hash();
          map = _map;
          map2 = _map2;
        }

        object = map[khash];

        if ((value = block(key, object)) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          keys2.push(key);
          map2[khash] = object;
        }
      }

      return result;
    
    };

    def.$replace = function(other) {
      var self = this;

      
      var keys  = self.keys = [],
          _map  = self.map  = {},
          smap  = self.smap = {},
          _map2 = other.map,
          smap2 = other.smap,
          key, khash, map, map2;

      for (var i = 0, length = other.keys.length; i < length; i++) {
        key = other.keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
          map2 = smap2;
        } else {
          khash = key.$hash();
          map = _map;
          map2 = _map2;
        }

        keys.push(key);
        map[khash] = map2[khash];
      }

      return self;
    
    };

    def.$select = TMP_12 = function() {
      var self = this, $iter = TMP_12.$$p, block = $iter || nil;

      TMP_12.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("select")
      };
      
      var keys   = self.keys,
          _map   = self.map,
          smap   = self.smap,
          result = Opal.hash(),
          _map2  = result.map,
          smap2  = result.smap,
          keys2  = result.keys,
          map, map2, key, khash, value, object;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
          map2 = smap2;
        } else {
          khash = key.$hash();
          map = _map;
          map2 = _map2;
        }

        value = map[khash];
        object = block(key, value);

        if (object === $breaker) {
          return $breaker.$v;
        }

        if (object !== false && object !== nil) {
          keys2.push(key);
          map2[khash] = value;
        }
      }

      return result;
    
    };

    def['$select!'] = TMP_13 = function() {
      var self = this, $iter = TMP_13.$$p, block = $iter || nil;

      TMP_13.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("select!")
      };
      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys,
          result = nil,
          key, khash, value, object, map;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        value = map[khash];
        object = block(key, value);

        if (object === $breaker) {
          return $breaker.$v;
        }

        if (object === false || object === nil) {
          keys.splice(i, 1);
          delete map[khash];

          length--;
          i--;
          result = self
        }
      }

      return result;
    
    };

    def.$shift = function() {
      var self = this;

      
      var keys = self.keys,
          _map = self.map,
          smap = self.smap,
          map, key, khash, value;

      if (keys.length) {
        key = keys[0];
        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }
        value = map[khash];

        delete map[khash];
        keys.splice(0, 1);

        return [key, value];
      }

      return nil;
    
    };

    Opal.defn(self, '$size', def.$length);

    self.$alias_method("store", "[]=");

    def.$to_a = function() {
      var self = this;

      
      var keys = self.keys,
          _map = self.map,
          smap = self.smap,
          result = [],
          map, key, khash;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        result.push([key, map[khash]]);
      }

      return result;
    
    };

    def.$to_h = function() {
      var self = this;

      
      if (self.$$class === Opal.Hash) {
        return self
      }

      var hash   = new Opal.Hash.$$alloc,
          cloned = self.$clone();

      hash.map  = cloned.map;
      hash.smap = cloned.smap;
      hash.keys = cloned.keys;
      hash.none = cloned.none;
      hash.proc = cloned.proc;

      return hash;
    ;
    };

    def.$to_hash = function() {
      var self = this;

      return self;
    };

    Opal.defn(self, '$to_s', def.$inspect);

    Opal.defn(self, '$update', def['$merge!']);

    Opal.defn(self, '$value?', def['$has_value?']);

    Opal.defn(self, '$values_at', def.$indexes);

    return (def.$values = function() {
      var self = this;

      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys,
          result = [],
          map, khash, key;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        result.push(map[khash]);
      }

      return result;
    
    }, nil) && 'values';
  })(self, null);
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/string"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $gvars = Opal.gvars;

  Opal.add_stubs(['$require', '$include', '$coerce_to?', '$coerce_to', '$raise', '$===', '$format', '$to_s', '$respond_to?', '$to_str', '$<=>', '$==', '$=~', '$new', '$empty?', '$ljust', '$ceil', '$rjust', '$floor', '$to_a', '$each_char', '$to_proc', '$coerce_to!', '$initialize_clone', '$initialize_dup', '$enum_for', '$chomp', '$[]', '$to_i', '$class', '$each_line', '$match', '$captures', '$proc', '$shift', '$__send__', '$succ', '$escape']);
  self.$require("corelib/comparable");
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_10;

    def.length = nil;
    self.$include($scope.get('Comparable'));

    def.$$is_string = true;

    def.$__id__ = function() {
      var self = this;

      return self.toString();
    };

    Opal.defn(self, '$object_id', def.$__id__);

    Opal.defs(self, '$try_convert', function(what) {
      var self = this;

      return $scope.get('Opal')['$coerce_to?'](what, $scope.get('String'), "to_str");
    });

    Opal.defs(self, '$new', function(str) {
      var self = this;

      if (str == null) {
        str = ""
      }
      str = $scope.get('Opal').$coerce_to(str, $scope.get('String'), "to_str");
      return new String(str);
    });

    def.$initialize = function(str) {
      var self = this;

      
      if (str === undefined) {
        return self;
      }
    
      return self.$raise($scope.get('NotImplementedError'), "Mutable strings are not supported in Opal.");
    };

    def['$%'] = function(data) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](data)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return ($a = self).$format.apply($a, [self].concat(data))
        } else {
        return self.$format(self, data)
      };
    };

    def['$*'] = function(count) {
      var self = this;

      
      count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");

      if (count < 0) {
        self.$raise($scope.get('ArgumentError'), "negative argument")
      }

      if (count === 0) {
        return '';
      }

      var result = '',
          string = self.toString();

      // All credit for the bit-twiddling magic code below goes to Mozilla
      // polyfill implementation of String.prototype.repeat() posted here:
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/repeat

      if (string.length * count >= 1 << 28) {
        self.$raise($scope.get('RangeError'), "multiply count must not overflow maximum string size")
      }

      for (;;) {
        if ((count & 1) === 1) {
          result += string;
        }
        count >>>= 1;
        if (count === 0) {
          break;
        }
        string += string;
      }

      return result;
    ;
    };

    def['$+'] = function(other) {
      var self = this;

      other = $scope.get('Opal').$coerce_to(other, $scope.get('String'), "to_str");
      return self + other.$to_s();
    };

    def['$<=>'] = function(other) {
      var $a, self = this;

      if ((($a = other['$respond_to?']("to_str")) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_str().$to_s();
        return self > other ? 1 : (self < other ? -1 : 0);
        } else {
        
        var cmp = other['$<=>'](self);

        if (cmp === nil) {
          return nil;
        }
        else {
          return cmp > 0 ? -1 : (cmp < 0 ? 1 : 0);
        }
      ;
      };
    };

    def['$<<'] = function(other) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), "#<< not supported. Mutable String methods are not supported in Opal.");
    };

    def['$=='] = function(other) {
      var self = this;

      
      if (other.$$is_string) {
        return self.toString() === other.toString();
      }
      if ($scope.get('Opal')['$respond_to?'](other, "to_str")) {
        return other['$=='](self);
      }
      return false;
    ;
    };

    Opal.defn(self, '$eql?', def['$==']);

    Opal.defn(self, '$===', def['$==']);

    def['$=~'] = function(other) {
      var self = this;

      
      if (other.$$is_string) {
        self.$raise($scope.get('TypeError'), "type mismatch: String given");
      }

      return other['$=~'](self);
    ;
    };

    def['$[]'] = function(index, length) {
      var self = this;

      
      var size = self.length;

      if (index.$$is_range) {
        var exclude = index.exclude,
            length  = $scope.get('Opal').$coerce_to(index.end, $scope.get('Integer'), "to_int"),
            index   = $scope.get('Opal').$coerce_to(index.begin, $scope.get('Integer'), "to_int");

        if (Math.abs(index) > size) {
          return nil;
        }

        if (index < 0) {
          index += size;
        }

        if (length < 0) {
          length += size;
        }

        if (!exclude) {
          length += 1;
        }

        length = length - index;

        if (length < 0) {
          length = 0;
        }

        return self.substr(index, length);
      }


      if (index.$$is_string) {
        if (length != null) {
          self.$raise($scope.get('TypeError'))
        }
        return self.indexOf(index) !== -1 ? index : nil;
      }


      if (index.$$is_regexp) {
        var match = self.match(index);

        if (match === null) {
          $gvars["~"] = nil
          return nil;
        }

        $gvars["~"] = $scope.get('MatchData').$new(index, match)

        if (length == null) {
          return match[0];
        }

        length = $scope.get('Opal').$coerce_to(length, $scope.get('Integer'), "to_int");

        if (length < 0 && -length < match.length) {
          return match[length += match.length];
        }

        if (length >= 0 && length < match.length) {
          return match[length];
        }

        return nil;
      }


      index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");

      if (index < 0) {
        index += size;
      }

      if (length == null) {
        if (index >= size || index < 0) {
          return nil;
        }
        return self.substr(index, 1);
      }

      length = $scope.get('Opal').$coerce_to(length, $scope.get('Integer'), "to_int");

      if (length < 0) {
        return nil;
      }

      if (index > size || index < 0) {
        return nil;
      }

      return self.substr(index, length);
    ;
    };

    def.$capitalize = function() {
      var self = this;

      return self.charAt(0).toUpperCase() + self.substr(1).toLowerCase();
    };

    Opal.defn(self, '$capitalize!', def['$<<']);

    def.$casecmp = function(other) {
      var self = this;

      other = $scope.get('Opal').$coerce_to(other, $scope.get('String'), "to_str").$to_s();
      
      var ascii_only = /^[\x00-\x7F]*$/;
      if (ascii_only.test(self) && ascii_only.test(other)) {
        self = self.toLowerCase();
        other = other.toLowerCase();
      }
    
      return self['$<=>'](other);
    };

    def.$center = function(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " "
      }
      width = $scope.get('Opal').$coerce_to(width, $scope.get('Integer'), "to_int");
      padstr = $scope.get('Opal').$coerce_to(padstr, $scope.get('String'), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "zero width padding")};
      if ((($a = width <= self.length) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self};
      
      var ljustified = self.$ljust($rb_divide(($rb_plus(width, self.length)), 2).$ceil(), padstr),
          rjustified = self.$rjust($rb_divide(($rb_plus(width, self.length)), 2).$floor(), padstr);

      return rjustified + ljustified.slice(self.length);
    ;
    };

    def.$chars = TMP_1 = function() {
      var $a, $b, self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$each_char().$to_a()
      };
      return ($a = ($b = self).$each_char, $a.$$p = block.$to_proc(), $a).call($b);
    };

    def.$chomp = function(separator) {
      var $a, self = this;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"]
      }
      if ((($a = separator === nil || self.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self};
      separator = $scope.get('Opal')['$coerce_to!'](separator, $scope.get('String'), "to_str").$to_s();
      
      if (separator === "\n") {
        return self.replace(/\r?\n?$/, '');
      }
      else if (separator === "") {
        return self.replace(/(\r?\n)+$/, '');
      }
      else if (self.length > separator.length) {
        var tail = self.substr(self.length - separator.length, separator.length);

        if (tail === separator) {
          return self.substr(0, self.length - separator.length);
        }
      }
    
      return self;
    };

    Opal.defn(self, '$chomp!', def['$<<']);

    def.$chop = function() {
      var self = this;

      
      var length = self.length;

      if (length <= 1) {
        return "";
      }

      if (self.charAt(length - 1) === "\n" && self.charAt(length - 2) === "\r") {
        return self.substr(0, length - 2);
      }
      else {
        return self.substr(0, length - 1);
      }
    
    };

    Opal.defn(self, '$chop!', def['$<<']);

    def.$chr = function() {
      var self = this;

      return self.charAt(0);
    };

    def.$clone = function() {
      var self = this, copy = nil;

      copy = self.slice();
      copy.$initialize_clone(self);
      return copy;
    };

    def.$dup = function() {
      var self = this, copy = nil;

      copy = self.slice();
      copy.$initialize_dup(self);
      return copy;
    };

    def.$count = function(sets) {
      var self = this;

      sets = $slice.call(arguments, 0);
      
      if (sets.length === 0) {
        self.$raise($scope.get('ArgumentError'), "ArgumentError: wrong number of arguments (0 for 1+)")
      }
      var char_class = char_class_from_char_sets(sets);
      if (char_class === null) {
        return 0;
      }
      return self.length - self.replace(new RegExp(char_class, 'g'), '').length;
    ;
    };

    def.$delete = function(sets) {
      var self = this;

      sets = $slice.call(arguments, 0);
      
      if (sets.length === 0) {
        self.$raise($scope.get('ArgumentError'), "ArgumentError: wrong number of arguments (0 for 1+)")
      }
      var char_class = char_class_from_char_sets(sets);
      if (char_class === null) {
        return self;
      }
      return self.replace(new RegExp(char_class, 'g'), '');
    ;
    };

    Opal.defn(self, '$dup', def.$clone);

    def.$downcase = function() {
      var self = this;

      return self.toLowerCase();
    };

    Opal.defn(self, '$downcase!', def['$<<']);

    def.$each_char = TMP_2 = function() {
      var $a, self = this, $iter = TMP_2.$$p, block = $iter || nil;

      TMP_2.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_char")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        ((($a = Opal.yield1(block, self.charAt(i))) === $breaker) ? $breaker.$v : $a);
      }
    
      return self;
    };

    def.$each_line = TMP_3 = function(separator) {
      var $a, self = this, $iter = TMP_3.$$p, $yield = $iter || nil;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"]
      }
      TMP_3.$$p = null;
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("each_line", separator)
      };
      
      if (separator === nil) {
        ((($a = Opal.yield1($yield, self)) === $breaker) ? $breaker.$v : $a);
        return self;
      }

      separator = $scope.get('Opal').$coerce_to(separator, $scope.get('String'), "to_str")

      if (separator.length === 0) {
        for (var a = self.split(/(\n{2,})/), i = 0, n = a.length; i < n; i += 2) {
          if (a[i] || a[i + 1]) {
            ((($a = Opal.yield1($yield, (a[i] || "") + (a[i + 1] || ""))) === $breaker) ? $breaker.$v : $a);
          }
        }
        return self;
      }

      var chomped  = self.$chomp(separator),
          trailing = self.length != chomped.length,
          splitted = chomped.split(separator);

      for (var i = 0, length = splitted.length; i < length; i++) {
        if (i < length - 1 || trailing) {
          ((($a = Opal.yield1($yield, splitted[i] + separator)) === $breaker) ? $breaker.$v : $a);
        }
        else {
          ((($a = Opal.yield1($yield, splitted[i])) === $breaker) ? $breaker.$v : $a);
        }
      }
    ;
      return self;
    };

    def['$empty?'] = function() {
      var self = this;

      return self.length === 0;
    };

    def['$end_with?'] = function(suffixes) {
      var self = this;

      suffixes = $slice.call(arguments, 0);
      
      for (var i = 0, length = suffixes.length; i < length; i++) {
        var suffix = $scope.get('Opal').$coerce_to(suffixes[i], $scope.get('String'), "to_str").$to_s();

        if (self.length >= suffix.length &&
            self.substr(self.length - suffix.length, suffix.length) == suffix) {
          return true;
        }
      }
    
      return false;
    };

    Opal.defn(self, '$eql?', def['$==']);

    Opal.defn(self, '$equal?', def['$===']);

    def.$gsub = TMP_4 = function(pattern, replacement) {
      var self = this, $iter = TMP_4.$$p, block = $iter || nil;

      TMP_4.$$p = null;
      
      var result = '', match_data = nil, index = 0, match, _replacement;

      if (pattern.$$is_regexp) {
        pattern = new RegExp(pattern.source, 'gm' + (pattern.ignoreCase ? 'i' : ''));
      } else {
        pattern = $scope.get('Opal').$coerce_to(pattern, $scope.get('String'), "to_str");
        pattern = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gm');
      }

      while (true) {
        match = pattern.exec(self);

        if (match === null) {
          $gvars["~"] = nil
          result += self.slice(index);
          break;
        }

        match_data = $scope.get('MatchData').$new(pattern, match);

        if (replacement === undefined) {
          if (block === nil) {
            self.$raise($scope.get('ArgumentError'), "wrong number of arguments (1 for 2)")
          }
          _replacement = block(match[0]);
        }
        else if (replacement.$$is_hash) {
          _replacement = (replacement)['$[]'](match[0]).$to_s();
        }
        else {
          if (!replacement.$$is_string) {
            replacement = $scope.get('Opal').$coerce_to(replacement, $scope.get('String'), "to_str");
          }
          _replacement = replacement.replace(/([\\]+)([0-9+&`'])/g, function (original, slashes, command) {
            if (slashes.length % 2 === 0) {
              return original;
            }
            switch (command) {
            case "+":
              for (var i = match.length - 1; i > 0; i--) {
                if (match[i] !== undefined) {
                  return slashes.slice(1) + match[i];
                }
              }
              return '';
            case "&": return slashes.slice(1) + match[0];
            case "`": return slashes.slice(1) + self.slice(0, match.index);
            case "'": return slashes.slice(1) + self.slice(match.index + match[0].length);
            default:  return slashes.slice(1) + (match[command] || '');
            }
          }).replace(/\\\\/g, '\\');
        }

        if (pattern.lastIndex === match.index) {
          result += (_replacement + self.slice(index, match.index + 1))
          pattern.lastIndex += 1;
        }
        else {
          result += (self.slice(index, match.index) + _replacement)
        }
        index = pattern.lastIndex;
      }

      $gvars["~"] = match_data
      return result;
    
    };

    Opal.defn(self, '$gsub!', def['$<<']);

    def.$hash = function() {
      var self = this;

      return self.toString();
    };

    def.$hex = function() {
      var self = this;

      return self.$to_i(16);
    };

    def['$include?'] = function(other) {
      var $a, self = this;

      
      if (other.$$is_string) {
        return self.indexOf(other) !== -1;
      }
    
      if ((($a = other['$respond_to?']("to_str")) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "no implicit conversion of " + (other.$class()) + " into String")
      };
      return self.indexOf(other.$to_str()) !== -1;
    };

    def.$index = function(search, offset) {
      var self = this;

      
      var index,
          match,
          regex;

      if (offset === undefined) {
        offset = 0;
      } else {
        offset = $scope.get('Opal').$coerce_to(offset, $scope.get('Integer'), "to_int");
        if (offset < 0) {
          offset += self.length;
          if (offset < 0) {
            return nil;
          }
        }
      }

      if (search.$$is_regexp) {
        regex = new RegExp(search.source, 'gm' + (search.ignoreCase ? 'i' : ''));
        while (true) {
          match = regex.exec(self);
          if (match === null) {
            $gvars["~"] = nil;
            index = -1;
            break;
          }
          if (match.index >= offset) {
            $gvars["~"] = $scope.get('MatchData').$new(regex, match)
            index = match.index;
            break;
          }
          regex.lastIndex = match.index + 1;
        }
      } else {
        search = $scope.get('Opal').$coerce_to(search, $scope.get('String'), "to_str");
        if (search.length === 0 && offset > self.length) {
          index = -1;
        } else {
          index = self.indexOf(search, offset);
        }
      }

      return index === -1 ? nil : index;
    
    };

    def.$inspect = function() {
      var self = this;

      
      var escapable = /[\\\"\x00-\x1f\x7f-\x9f\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
          meta = {
            '\u0007': '\\a',
            '\u001b': '\\e',
            '\b': '\\b',
            '\t': '\\t',
            '\n': '\\n',
            '\f': '\\f',
            '\r': '\\r',
            '\v': '\\v',
            '"' : '\\"',
            '\\': '\\\\'
          },
          escaped = self.replace(escapable, function (chr) {
            return meta[chr] || '\\u' + ('0000' + chr.charCodeAt(0).toString(16).toUpperCase()).slice(-4);
          });
      return '"' + escaped.replace(/\#[\$\@\{]/g, '\\$&') + '"';
    
    };

    def.$intern = function() {
      var self = this;

      return self;
    };

    def.$lines = TMP_5 = function(separator) {
      var $a, $b, self = this, $iter = TMP_5.$$p, block = $iter || nil, e = nil;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"]
      }
      TMP_5.$$p = null;
      e = ($a = ($b = self).$each_line, $a.$$p = block.$to_proc(), $a).call($b, separator);
      if (block !== false && block !== nil) {
        return self
        } else {
        return e.$to_a()
      };
    };

    def.$length = function() {
      var self = this;

      return self.length;
    };

    def.$ljust = function(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " "
      }
      width = $scope.get('Opal').$coerce_to(width, $scope.get('Integer'), "to_int");
      padstr = $scope.get('Opal').$coerce_to(padstr, $scope.get('String'), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "zero width padding")};
      if ((($a = width <= self.length) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self};
      
      var index  = -1,
          result = "";

      width -= self.length;

      while (++index < width) {
        result += padstr;
      }

      return self + result.slice(0, width);
    
    };

    def.$lstrip = function() {
      var self = this;

      return self.replace(/^\s*/, '');
    };

    Opal.defn(self, '$lstrip!', def['$<<']);

    def.$match = TMP_6 = function(pattern, pos) {
      var $a, $b, self = this, $iter = TMP_6.$$p, block = $iter || nil;

      TMP_6.$$p = null;
      if ((($a = ((($b = $scope.get('String')['$==='](pattern)) !== false && $b !== nil) ? $b : pattern['$respond_to?']("to_str"))) !== nil && (!$a.$$is_boolean || $a == true))) {
        pattern = $scope.get('Regexp').$new(pattern.$to_str())};
      if ((($a = $scope.get('Regexp')['$==='](pattern)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "wrong argument type " + (pattern.$class()) + " (expected Regexp)")
      };
      return ($a = ($b = pattern).$match, $a.$$p = block.$to_proc(), $a).call($b, self, pos);
    };

    def.$next = function() {
      var self = this;

      
      var i = self.length;
      if (i === 0) {
        return '';
      }
      var result = self;
      var first_alphanum_char_index = self.search(/[a-zA-Z0-9]/);
      var carry = false;
      var code;
      while (i--) {
        code = self.charCodeAt(i);
        if ((code >= 48 && code <= 57) ||
          (code >= 65 && code <= 90) ||
          (code >= 97 && code <= 122)) {
          switch (code) {
          case 57:
            carry = true;
            code = 48;
            break;
          case 90:
            carry = true;
            code = 65;
            break;
          case 122:
            carry = true;
            code = 97;
            break;
          default:
            carry = false;
            code += 1;
          }
        } else {
          if (first_alphanum_char_index === -1) {
            if (code === 255) {
              carry = true;
              code = 0;
            } else {
              carry = false;
              code += 1;
            }
          } else {
            carry = true;
          }
        }
        result = result.slice(0, i) + String.fromCharCode(code) + result.slice(i + 1);
        if (carry && (i === 0 || i === first_alphanum_char_index)) {
          switch (code) {
          case 65:
            break;
          case 97:
            break;
          default:
            code += 1;
          }
          if (i === 0) {
            result = String.fromCharCode(code) + result;
          } else {
            result = result.slice(0, i) + String.fromCharCode(code) + result.slice(i);
          }
          carry = false;
        }
        if (!carry) {
          break;
        }
      }
      return result;
    
    };

    Opal.defn(self, '$next!', def['$<<']);

    def.$oct = function() {
      var self = this;

      
      var result,
          string = self,
          radix = 8;

      if (/^\s*_/.test(string)) {
        return 0;
      }

      string = string.replace(/^(\s*[+-]?)(0[bodx]?)(.+)$/i, function (original, head, flag, tail) {
        switch (tail.charAt(0)) {
        case '+':
        case '-':
          return original;
        case '0':
          if (tail.charAt(1) === 'x' && flag === '0x') {
            return original;
          }
        }
        switch (flag) {
        case '0b':
          radix = 2;
          break;
        case '0':
        case '0o':
          radix = 8;
          break;
        case '0d':
          radix = 10;
          break;
        case '0x':
          radix = 16;
          break;
        }
        return head + tail;
      });

      result = parseInt(string.replace(/_(?!_)/g, ''), radix);
      return isNaN(result) ? 0 : result;
    
    };

    def.$ord = function() {
      var self = this;

      return self.charCodeAt(0);
    };

    def.$partition = function(sep) {
      var self = this;

      
      var i, m;

      if (sep.$$is_regexp) {
        m = sep.exec(self);
        if (m === null) {
          i = -1;
        } else {
          $scope.get('MatchData').$new(sep, m);
          sep = m[0];
          i = m.index;
        }
      } else {
        sep = $scope.get('Opal').$coerce_to(sep, $scope.get('String'), "to_str");
        i = self.indexOf(sep);
      }

      if (i === -1) {
        return [self, '', ''];
      }

      return [
        self.slice(0, i),
        self.slice(i, i + sep.length),
        self.slice(i + sep.length)
      ];
    
    };

    def.$reverse = function() {
      var self = this;

      return self.split('').reverse().join('');
    };

    Opal.defn(self, '$reverse!', def['$<<']);

    def.$rindex = function(search, offset) {
      var self = this;

      
      var i, m, r, _m;

      if (offset === undefined) {
        offset = self.length;
      } else {
        offset = $scope.get('Opal').$coerce_to(offset, $scope.get('Integer'), "to_int");
        if (offset < 0) {
          offset += self.length;
          if (offset < 0) {
            return nil;
          }
        }
      }

      if (search.$$is_regexp) {
        m = null;
        r = new RegExp(search.source, 'gm' + (search.ignoreCase ? 'i' : ''));
        while (true) {
          _m = r.exec(self);
          if (_m === null || _m.index > offset) {
            break;
          }
          m = _m;
          r.lastIndex = m.index + 1;
        }
        if (m === null) {
          $gvars["~"] = nil
          i = -1;
        } else {
          $scope.get('MatchData').$new(r, m);
          i = m.index;
        }
      } else {
        search = $scope.get('Opal').$coerce_to(search, $scope.get('String'), "to_str");
        i = self.lastIndexOf(search, offset);
      }

      return i === -1 ? nil : i;
    
    };

    def.$rjust = function(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " "
      }
      width = $scope.get('Opal').$coerce_to(width, $scope.get('Integer'), "to_int");
      padstr = $scope.get('Opal').$coerce_to(padstr, $scope.get('String'), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "zero width padding")};
      if ((($a = width <= self.length) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self};
      
      var chars     = Math.floor(width - self.length),
          patterns  = Math.floor(chars / padstr.length),
          result    = Array(patterns + 1).join(padstr),
          remaining = chars - result.length;

      return result + padstr.slice(0, remaining) + self;
    
    };

    def.$rpartition = function(sep) {
      var self = this;

      
      var i, m, r, _m;

      if (sep.$$is_regexp) {
        m = null;
        r = new RegExp(sep.source, 'gm' + (sep.ignoreCase ? 'i' : ''));

        while (true) {
          _m = r.exec(self);
          if (_m === null) {
            break;
          }
          m = _m;
          r.lastIndex = m.index + 1;
        }

        if (m === null) {
          i = -1;
        } else {
          $scope.get('MatchData').$new(r, m);
          sep = m[0];
          i = m.index;
        }

      } else {
        sep = $scope.get('Opal').$coerce_to(sep, $scope.get('String'), "to_str");
        i = self.lastIndexOf(sep);
      }

      if (i === -1) {
        return ['', '', self];
      }

      return [
        self.slice(0, i),
        self.slice(i, i + sep.length),
        self.slice(i + sep.length)
      ];
    
    };

    def.$rstrip = function() {
      var self = this;

      return self.replace(/[\s\u0000]*$/, '');
    };

    def.$scan = TMP_7 = function(pattern) {
      var self = this, $iter = TMP_7.$$p, block = $iter || nil;

      TMP_7.$$p = null;
      
      var result = [],
          match_data = nil,
          match;

      if (pattern.$$is_regexp) {
        pattern = new RegExp(pattern.source, 'gm' + (pattern.ignoreCase ? 'i' : ''));
      } else {
        pattern = $scope.get('Opal').$coerce_to(pattern, $scope.get('String'), "to_str");
        pattern = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gm');
      }

      while ((match = pattern.exec(self)) != null) {
        match_data = $scope.get('MatchData').$new(pattern, match);
        if (block === nil) {
          match.length == 1 ? result.push(match[0]) : result.push((match_data).$captures());
        } else {
          match.length == 1 ? block(match[0]) : block.call(self, (match_data).$captures());
        }
        if (pattern.lastIndex === match.index) {
          pattern.lastIndex += 1;
        }
      }

      $gvars["~"] = match_data

      return (block !== nil ? self : result);
    
    };

    Opal.defn(self, '$size', def.$length);

    Opal.defn(self, '$slice', def['$[]']);

    Opal.defn(self, '$slice!', def['$<<']);

    def.$split = function(pattern, limit) {
      var $a, self = this;
      if ($gvars[";"] == null) $gvars[";"] = nil;

      
      if (self.length === 0) {
        return [];
      }

      if (limit === undefined) {
        limit = 0;
      } else {
        limit = $scope.get('Opal')['$coerce_to!'](limit, $scope.get('Integer'), "to_int");
        if (limit === 1) {
          return [self];
        }
      }

      if (pattern === undefined || pattern === nil) {
        pattern = ((($a = $gvars[";"]) !== false && $a !== nil) ? $a : " ");
      }

      var result = [],
          string = self.toString(),
          index = 0,
          match,
          i;

      if (pattern.$$is_regexp) {
        pattern = new RegExp(pattern.source, 'gm' + (pattern.ignoreCase ? 'i' : ''));
      } else {
        pattern = $scope.get('Opal').$coerce_to(pattern, $scope.get('String'), "to_str").$to_s();
        if (pattern === ' ') {
          pattern = /\s+/gm;
          string = string.replace(/^\s+/, '');
        } else {
          pattern = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gm');
        }
      }

      result = string.split(pattern);

      if (result.length === 1 && result[0] === string) {
        return result;
      }

      while ((i = result.indexOf(undefined)) !== -1) {
        result.splice(i, 1);
      }

      if (limit === 0) {
        while (result[result.length - 1] === '') {
          result.length -= 1;
        }
        return result;
      }

      match = pattern.exec(string);

      if (limit < 0) {
        if (match !== null && match[0] === '' && pattern.source.indexOf('(?=') === -1) {
          for (i = 0; i < match.length; i++) {
            result.push('');
          }
        }
        return result;
      }

      if (match !== null && match[0] === '') {
        result.splice(limit - 1, result.length - 1, result.slice(limit - 1).join(''));
        return result;
      }

      i = 0;
      while (match !== null) {
        i++;
        index = pattern.lastIndex;
        if (i + 1 === limit) {
          break;
        }
        match = pattern.exec(string);
      }

      result.splice(limit - 1, result.length - 1, string.slice(index));
      return result;
    
    };

    def.$squeeze = function(sets) {
      var self = this;

      sets = $slice.call(arguments, 0);
      
      if (sets.length === 0) {
        return self.replace(/(.)\1+/g, '$1');
      }
      var char_class = char_class_from_char_sets(sets);
      if (char_class === null) {
        return self;
      }
      return self.replace(new RegExp('(' + char_class + ')\\1+', 'g'), '$1');
    
    };

    Opal.defn(self, '$squeeze!', def['$<<']);

    def['$start_with?'] = function(prefixes) {
      var self = this;

      prefixes = $slice.call(arguments, 0);
      
      for (var i = 0, length = prefixes.length; i < length; i++) {
        var prefix = $scope.get('Opal').$coerce_to(prefixes[i], $scope.get('String'), "to_str").$to_s();

        if (self.indexOf(prefix) === 0) {
          return true;
        }
      }

      return false;
    
    };

    def.$strip = function() {
      var self = this;

      return self.replace(/^\s*/, '').replace(/[\s\u0000]*$/, '');
    };

    Opal.defn(self, '$strip!', def['$<<']);

    def.$sub = TMP_8 = function(pattern, replacement) {
      var self = this, $iter = TMP_8.$$p, block = $iter || nil;

      TMP_8.$$p = null;
      
      if (!pattern.$$is_regexp) {
        pattern = $scope.get('Opal').$coerce_to(pattern, $scope.get('String'), "to_str");
        pattern = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }

      var result = pattern.exec(self);

      if (result === null) {
        $gvars["~"] = nil
        return self.toString();
      }

      $scope.get('MatchData').$new(pattern, result)

      if (replacement === undefined) {
        if (block === nil) {
          self.$raise($scope.get('ArgumentError'), "wrong number of arguments (1 for 2)")
        }
        return self.slice(0, result.index) + block(result[0]) + self.slice(result.index + result[0].length);
      }

      if (replacement.$$is_hash) {
        return self.slice(0, result.index) + (replacement)['$[]'](result[0]).$to_s() + self.slice(result.index + result[0].length);
      }

      replacement = $scope.get('Opal').$coerce_to(replacement, $scope.get('String'), "to_str");

      replacement = replacement.replace(/([\\]+)([0-9+&`'])/g, function (original, slashes, command) {
        if (slashes.length % 2 === 0) {
          return original;
        }
        switch (command) {
        case "+":
          for (var i = result.length - 1; i > 0; i--) {
            if (result[i] !== undefined) {
              return slashes.slice(1) + result[i];
            }
          }
          return '';
        case "&": return slashes.slice(1) + result[0];
        case "`": return slashes.slice(1) + self.slice(0, result.index);
        case "'": return slashes.slice(1) + self.slice(result.index + result[0].length);
        default:  return slashes.slice(1) + (result[command] || '');
        }
      }).replace(/\\\\/g, '\\');

      return self.slice(0, result.index) + replacement + self.slice(result.index + result[0].length);
    ;
    };

    Opal.defn(self, '$sub!', def['$<<']);

    Opal.defn(self, '$succ', def.$next);

    Opal.defn(self, '$succ!', def['$<<']);

    def.$sum = function(n) {
      var self = this;

      if (n == null) {
        n = 16
      }
      
      n = $scope.get('Opal').$coerce_to(n, $scope.get('Integer'), "to_int");

      var result = 0,
          length = self.length,
          i = 0;

      for (; i < length; i++) {
        result += self.charCodeAt(i);
      }

      if (n <= 0) {
        return result;
      }

      return result & (Math.pow(2, n) - 1);
    ;
    };

    def.$swapcase = function() {
      var self = this;

      
      var str = self.replace(/([a-z]+)|([A-Z]+)/g, function($0,$1,$2) {
        return $1 ? $0.toUpperCase() : $0.toLowerCase();
      });

      if (self.constructor === String) {
        return str;
      }

      return self.$class().$new(str);
    
    };

    Opal.defn(self, '$swapcase!', def['$<<']);

    def.$to_f = function() {
      var self = this;

      
      if (self.charAt(0) === '_') {
        return 0;
      }

      var result = parseFloat(self.replace(/_/g, ''));

      if (isNaN(result) || result == Infinity || result == -Infinity) {
        return 0;
      }
      else {
        return result;
      }
    
    };

    def.$to_i = function(base) {
      var self = this;

      if (base == null) {
        base = 10
      }
      
      var result,
          string = self.toLowerCase(),
          radix = $scope.get('Opal').$coerce_to(base, $scope.get('Integer'), "to_int");

      if (radix === 1 || radix < 0 || radix > 36) {
        self.$raise($scope.get('ArgumentError'), "invalid radix " + (radix))
      }

      if (/^\s*_/.test(string)) {
        return 0;
      }

      string = string.replace(/^(\s*[+-]?)(0[bodx]?)(.+)$/, function (original, head, flag, tail) {
        switch (tail.charAt(0)) {
        case '+':
        case '-':
          return original;
        case '0':
          if (tail.charAt(1) === 'x' && flag === '0x' && (radix === 0 || radix === 16)) {
            return original;
          }
        }
        switch (flag) {
        case '0b':
          if (radix === 0 || radix === 2) {
            radix = 2;
            return head + tail;
          }
          break;
        case '0':
        case '0o':
          if (radix === 0 || radix === 8) {
            radix = 8;
            return head + tail;
          }
          break;
        case '0d':
          if (radix === 0 || radix === 10) {
            radix = 10;
            return head + tail;
          }
          break;
        case '0x':
          if (radix === 0 || radix === 16) {
            radix = 16;
            return head + tail;
          }
          break;
        }
        return original
      });

      result = parseInt(string.replace(/_(?!_)/g, ''), radix);
      return isNaN(result) ? 0 : result;
    ;
    };

    def.$to_proc = function() {
      var $a, $b, TMP_9, self = this, sym = nil;

      sym = self;
      return ($a = ($b = self).$proc, $a.$$p = (TMP_9 = function(args){var self = TMP_9.$$s || this, block, $a, $b, obj = nil;
args = $slice.call(arguments, 0);
        block = TMP_9.$$p || nil, TMP_9.$$p = null;
      if ((($a = args['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('ArgumentError'), "no receiver given")};
        obj = args.$shift();
        return ($a = ($b = obj).$__send__, $a.$$p = block.$to_proc(), $a).apply($b, [sym].concat(args));}, TMP_9.$$s = self, TMP_9), $a).call($b);
    };

    def.$to_s = function() {
      var self = this;

      return self.toString();
    };

    Opal.defn(self, '$to_str', def.$to_s);

    Opal.defn(self, '$to_sym', def.$intern);

    def.$tr = function(from, to) {
      var self = this;

      from = $scope.get('Opal').$coerce_to(from, $scope.get('String'), "to_str").$to_s();
      to = $scope.get('Opal').$coerce_to(to, $scope.get('String'), "to_str").$to_s();
      
      if (from.length == 0 || from === to) {
        return self;
      }

      var subs = {};
      var from_chars = from.split('');
      var from_length = from_chars.length;
      var to_chars = to.split('');
      var to_length = to_chars.length;

      var inverse = false;
      var global_sub = null;
      if (from_chars[0] === '^' && from_chars.length > 1) {
        inverse = true;
        from_chars.shift();
        global_sub = to_chars[to_length - 1]
        from_length -= 1;
      }

      var from_chars_expanded = [];
      var last_from = null;
      var in_range = false;
      for (var i = 0; i < from_length; i++) {
        var ch = from_chars[i];
        if (last_from == null) {
          last_from = ch;
          from_chars_expanded.push(ch);
        }
        else if (ch === '-') {
          if (last_from === '-') {
            from_chars_expanded.push('-');
            from_chars_expanded.push('-');
          }
          else if (i == from_length - 1) {
            from_chars_expanded.push('-');
          }
          else {
            in_range = true;
          }
        }
        else if (in_range) {
          var start = last_from.charCodeAt(0);
          var end = ch.charCodeAt(0);
          if (start > end) {
            self.$raise($scope.get('ArgumentError'), "invalid range \"" + (String.fromCharCode(start)) + "-" + (String.fromCharCode(end)) + "\" in string transliteration")
          }
          for (var c = start + 1; c < end; c++) {
            from_chars_expanded.push(String.fromCharCode(c));
          }
          from_chars_expanded.push(ch);
          in_range = null;
          last_from = null;
        }
        else {
          from_chars_expanded.push(ch);
        }
      }

      from_chars = from_chars_expanded;
      from_length = from_chars.length;

      if (inverse) {
        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = true;
        }
      }
      else {
        if (to_length > 0) {
          var to_chars_expanded = [];
          var last_to = null;
          var in_range = false;
          for (var i = 0; i < to_length; i++) {
            var ch = to_chars[i];
            if (last_from == null) {
              last_from = ch;
              to_chars_expanded.push(ch);
            }
            else if (ch === '-') {
              if (last_to === '-') {
                to_chars_expanded.push('-');
                to_chars_expanded.push('-');
              }
              else if (i == to_length - 1) {
                to_chars_expanded.push('-');
              }
              else {
                in_range = true;
              }
            }
            else if (in_range) {
              var start = last_from.charCodeAt(0);
              var end = ch.charCodeAt(0);
              if (start > end) {
                self.$raise($scope.get('ArgumentError'), "invalid range \"" + (String.fromCharCode(start)) + "-" + (String.fromCharCode(end)) + "\" in string transliteration")
              }
              for (var c = start + 1; c < end; c++) {
                to_chars_expanded.push(String.fromCharCode(c));
              }
              to_chars_expanded.push(ch);
              in_range = null;
              last_from = null;
            }
            else {
              to_chars_expanded.push(ch);
            }
          }

          to_chars = to_chars_expanded;
          to_length = to_chars.length;
        }

        var length_diff = from_length - to_length;
        if (length_diff > 0) {
          var pad_char = (to_length > 0 ? to_chars[to_length - 1] : '');
          for (var i = 0; i < length_diff; i++) {
            to_chars.push(pad_char);
          }
        }

        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = to_chars[i];
        }
      }

      var new_str = ''
      for (var i = 0, length = self.length; i < length; i++) {
        var ch = self.charAt(i);
        var sub = subs[ch];
        if (inverse) {
          new_str += (sub == null ? global_sub : ch);
        }
        else {
          new_str += (sub != null ? sub : ch);
        }
      }
      return new_str;
    
    };

    Opal.defn(self, '$tr!', def['$<<']);

    def.$tr_s = function(from, to) {
      var self = this;

      from = $scope.get('Opal').$coerce_to(from, $scope.get('String'), "to_str").$to_s();
      to = $scope.get('Opal').$coerce_to(to, $scope.get('String'), "to_str").$to_s();
      
      if (from.length == 0) {
        return self;
      }

      var subs = {};
      var from_chars = from.split('');
      var from_length = from_chars.length;
      var to_chars = to.split('');
      var to_length = to_chars.length;

      var inverse = false;
      var global_sub = null;
      if (from_chars[0] === '^' && from_chars.length > 1) {
        inverse = true;
        from_chars.shift();
        global_sub = to_chars[to_length - 1]
        from_length -= 1;
      }

      var from_chars_expanded = [];
      var last_from = null;
      var in_range = false;
      for (var i = 0; i < from_length; i++) {
        var ch = from_chars[i];
        if (last_from == null) {
          last_from = ch;
          from_chars_expanded.push(ch);
        }
        else if (ch === '-') {
          if (last_from === '-') {
            from_chars_expanded.push('-');
            from_chars_expanded.push('-');
          }
          else if (i == from_length - 1) {
            from_chars_expanded.push('-');
          }
          else {
            in_range = true;
          }
        }
        else if (in_range) {
          var start = last_from.charCodeAt(0);
          var end = ch.charCodeAt(0);
          if (start > end) {
            self.$raise($scope.get('ArgumentError'), "invalid range \"" + (String.fromCharCode(start)) + "-" + (String.fromCharCode(end)) + "\" in string transliteration")
          }
          for (var c = start + 1; c < end; c++) {
            from_chars_expanded.push(String.fromCharCode(c));
          }
          from_chars_expanded.push(ch);
          in_range = null;
          last_from = null;
        }
        else {
          from_chars_expanded.push(ch);
        }
      }

      from_chars = from_chars_expanded;
      from_length = from_chars.length;

      if (inverse) {
        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = true;
        }
      }
      else {
        if (to_length > 0) {
          var to_chars_expanded = [];
          var last_to = null;
          var in_range = false;
          for (var i = 0; i < to_length; i++) {
            var ch = to_chars[i];
            if (last_from == null) {
              last_from = ch;
              to_chars_expanded.push(ch);
            }
            else if (ch === '-') {
              if (last_to === '-') {
                to_chars_expanded.push('-');
                to_chars_expanded.push('-');
              }
              else if (i == to_length - 1) {
                to_chars_expanded.push('-');
              }
              else {
                in_range = true;
              }
            }
            else if (in_range) {
              var start = last_from.charCodeAt(0);
              var end = ch.charCodeAt(0);
              if (start > end) {
                self.$raise($scope.get('ArgumentError'), "invalid range \"" + (String.fromCharCode(start)) + "-" + (String.fromCharCode(end)) + "\" in string transliteration")
              }
              for (var c = start + 1; c < end; c++) {
                to_chars_expanded.push(String.fromCharCode(c));
              }
              to_chars_expanded.push(ch);
              in_range = null;
              last_from = null;
            }
            else {
              to_chars_expanded.push(ch);
            }
          }

          to_chars = to_chars_expanded;
          to_length = to_chars.length;
        }

        var length_diff = from_length - to_length;
        if (length_diff > 0) {
          var pad_char = (to_length > 0 ? to_chars[to_length - 1] : '');
          for (var i = 0; i < length_diff; i++) {
            to_chars.push(pad_char);
          }
        }

        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = to_chars[i];
        }
      }
      var new_str = ''
      var last_substitute = null
      for (var i = 0, length = self.length; i < length; i++) {
        var ch = self.charAt(i);
        var sub = subs[ch]
        if (inverse) {
          if (sub == null) {
            if (last_substitute == null) {
              new_str += global_sub;
              last_substitute = true;
            }
          }
          else {
            new_str += ch;
            last_substitute = null;
          }
        }
        else {
          if (sub != null) {
            if (last_substitute == null || last_substitute !== sub) {
              new_str += sub;
              last_substitute = sub;
            }
          }
          else {
            new_str += ch;
            last_substitute = null;
          }
        }
      }
      return new_str;
    
    };

    Opal.defn(self, '$tr_s!', def['$<<']);

    def.$upcase = function() {
      var self = this;

      return self.toUpperCase();
    };

    Opal.defn(self, '$upcase!', def['$<<']);

    def.$freeze = function() {
      var self = this;

      return self;
    };

    def['$frozen?'] = function() {
      var self = this;

      return true;
    };

    def.$upto = TMP_10 = function(stop, excl) {
      var self = this, $iter = TMP_10.$$p, block = $iter || nil;

      if (excl == null) {
        excl = false
      }
      TMP_10.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("upto", stop, excl)
      };
      stop = $scope.get('Opal').$coerce_to(stop, $scope.get('String'), "to_str");
      
      var a, b, s = self.toString();

      if (s.length === 1 && stop.length === 1) {

        a = s.charCodeAt(0);
        b = stop.charCodeAt(0);

        while (a <= b) {
          if (excl && a === b) {
            break;
          }
          block(String.fromCharCode(a));
          a += 1;
        }

      } else if (parseInt(s).toString() === s && parseInt(stop).toString() === stop) {

        a = parseInt(s);
        b = parseInt(stop);

        while (a <= b) {
          if (excl && a === b) {
            break;
          }
          block(a.toString());
          a += 1;
        }

      } else {

        while (s.length <= stop.length && s <= stop) {
          if (excl && s === stop) {
            break;
          }
          block(s);
          s = (s).$succ();
        }

      }
      return self;
    
    };

    
    function char_class_from_char_sets(sets) {
      function explode_sequences_in_character_set(set) {
        var result = '',
            i, len = set.length,
            curr_char,
            skip_next_dash,
            char_code_from,
            char_code_upto,
            char_code;
        for (i = 0; i < len; i++) {
          curr_char = set.charAt(i);
          if (curr_char === '-' && i > 0 && i < (len - 1) && !skip_next_dash) {
            char_code_from = set.charCodeAt(i - 1);
            char_code_upto = set.charCodeAt(i + 1);
            if (char_code_from > char_code_upto) {
              self.$raise($scope.get('ArgumentError'), "invalid range \"" + (char_code_from) + "-" + (char_code_upto) + "\" in string transliteration")
            }
            for (char_code = char_code_from + 1; char_code < char_code_upto + 1; char_code++) {
              result += String.fromCharCode(char_code);
            }
            skip_next_dash = true;
            i++;
          } else {
            skip_next_dash = (curr_char === '\\');
            result += curr_char;
          }
        }
        return result;
      }

      function intersection(setA, setB) {
        if (setA.length === 0) {
          return setB;
        }
        var result = '',
            i, len = setA.length,
            chr;
        for (i = 0; i < len; i++) {
          chr = setA.charAt(i);
          if (setB.indexOf(chr) !== -1) {
            result += chr;
          }
        }
        return result;
      }

      var i, len, set, neg, chr, tmp,
          pos_intersection = '',
          neg_intersection = '';

      for (i = 0, len = sets.length; i < len; i++) {
        set = $scope.get('Opal').$coerce_to(sets[i], $scope.get('String'), "to_str");
        neg = (set.charAt(0) === '^' && set.length > 1);
        set = explode_sequences_in_character_set(neg ? set.slice(1) : set);
        if (neg) {
          neg_intersection = intersection(neg_intersection, set);
        } else {
          pos_intersection = intersection(pos_intersection, set);
        }
      }

      if (pos_intersection.length > 0 && neg_intersection.length > 0) {
        tmp = '';
        for (i = 0, len = pos_intersection.length; i < len; i++) {
          chr = pos_intersection.charAt(i);
          if (neg_intersection.indexOf(chr) === -1) {
            tmp += chr;
          }
        }
        pos_intersection = tmp;
        neg_intersection = '';
      }

      if (pos_intersection.length > 0) {
        return '[' + $scope.get('Regexp').$escape(pos_intersection) + ']';
      }

      if (neg_intersection.length > 0) {
        return '[^' + $scope.get('Regexp').$escape(neg_intersection) + ']';
      }

      return null;
    }
  
  })(self, null);
  return Opal.cdecl($scope, 'Symbol', $scope.get('String'));
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/string/inheritance"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $gvars = Opal.gvars;

  Opal.add_stubs(['$new', '$allocate', '$initialize', '$to_proc', '$__send__', '$class', '$clone', '$respond_to?', '$==', '$inspect', '$map', '$split', '$enum_for', '$each_line', '$to_a', '$%']);
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self.$$proto, $scope = self.$$scope;

    return (Opal.defs(self, '$inherited', function(klass) {
      var self = this, replace = nil;

      replace = $scope.get('Class').$new((($scope.get('String')).$$scope.get('Wrapper')));
      
      klass.$$proto         = replace.$$proto;
      klass.$$proto.$$class = klass;
      klass.$$alloc         = replace.$$alloc;
      klass.$$parent        = (($scope.get('String')).$$scope.get('Wrapper'));

      klass.$allocate = replace.$allocate;
      klass.$new      = replace.$new;
    
    }), nil) && 'inherited'
  })(self, null);
  return (function($base, $super) {
    function $Wrapper(){};
    var self = $Wrapper = $klass($base, $super, 'Wrapper', $Wrapper);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_6, TMP_8;

    def.literal = nil;
    def.$$is_string = true;

    Opal.defs(self, '$allocate', TMP_1 = function(string) {
      var self = this, $iter = TMP_1.$$p, $yield = $iter || nil, obj = nil;

      if (string == null) {
        string = ""
      }
      TMP_1.$$p = null;
      obj = Opal.find_super_dispatcher(self, 'allocate', TMP_1, null, $Wrapper).apply(self, []);
      obj.literal = string;
      return obj;
    });

    Opal.defs(self, '$new', TMP_2 = function(args) {
      var $a, $b, self = this, $iter = TMP_2.$$p, block = $iter || nil, obj = nil;

      args = $slice.call(arguments, 0);
      TMP_2.$$p = null;
      obj = self.$allocate();
      ($a = ($b = obj).$initialize, $a.$$p = block.$to_proc(), $a).apply($b, [].concat(args));
      return obj;
    });

    Opal.defs(self, '$[]', function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      return self.$allocate(objects);
    });

    def.$initialize = function(string) {
      var self = this;

      if (string == null) {
        string = ""
      }
      return self.literal = string;
    };

    def.$method_missing = TMP_3 = function(args) {
      var $a, $b, self = this, $iter = TMP_3.$$p, block = $iter || nil, result = nil;

      args = $slice.call(arguments, 0);
      TMP_3.$$p = null;
      result = ($a = ($b = self.literal).$__send__, $a.$$p = block.$to_proc(), $a).apply($b, [].concat(args));
      if ((($a = result.$$is_string != null) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ((($a = result == self.literal) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self
          } else {
          return self.$class().$allocate(result)
        }
        } else {
        return result
      };
    };

    def.$initialize_copy = function(other) {
      var self = this;

      return self.literal = (other.literal).$clone();
    };

    def['$respond_to?'] = TMP_4 = function(name) {var $zuper = $slice.call(arguments, 0);
      var $a, self = this, $iter = TMP_4.$$p, $yield = $iter || nil;

      TMP_4.$$p = null;
      return ((($a = Opal.find_super_dispatcher(self, 'respond_to?', TMP_4, $iter).apply(self, $zuper)) !== false && $a !== nil) ? $a : self.literal['$respond_to?'](name));
    };

    def['$=='] = function(other) {
      var self = this;

      return self.literal['$=='](other);
    };

    Opal.defn(self, '$eql?', def['$==']);

    Opal.defn(self, '$===', def['$==']);

    def.$to_s = function() {
      var self = this;

      return self.literal;
    };

    Opal.defn(self, '$to_str', def.$to_s);

    def.$inspect = function() {
      var self = this;

      return self.literal.$inspect();
    };

    def['$+'] = function(other) {
      var self = this;

      return $rb_plus(self.literal, other);
    };

    def['$*'] = function(other) {
      var self = this;

      
      var result = $rb_times(self.literal, other);

      if (result.$$is_string) {
        return self.$class().$allocate(result)
      }
      else {
        return result;
      }
    ;
    };

    def.$split = function(pattern, limit) {
      var $a, $b, TMP_5, self = this;

      return ($a = ($b = self.literal.$split(pattern, limit)).$map, $a.$$p = (TMP_5 = function(str){var self = TMP_5.$$s || this;
if (str == null) str = nil;
      return self.$class().$allocate(str)}, TMP_5.$$s = self, TMP_5), $a).call($b);
    };

    def.$replace = function(string) {
      var self = this;

      return self.literal = string;
    };

    def.$each_line = TMP_6 = function(separator) {
      var $a, $b, TMP_7, self = this, $iter = TMP_6.$$p, $yield = $iter || nil;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"]
      }
      TMP_6.$$p = null;
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("each_line", separator)
      };
      return ($a = ($b = self.literal).$each_line, $a.$$p = (TMP_7 = function(str){var self = TMP_7.$$s || this, $a;
if (str == null) str = nil;
      return $a = Opal.yield1($yield, self.$class().$allocate(str)), $a === $breaker ? $a : $a}, TMP_7.$$s = self, TMP_7), $a).call($b, separator);
    };

    def.$lines = TMP_8 = function(separator) {
      var $a, $b, self = this, $iter = TMP_8.$$p, block = $iter || nil, e = nil;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"]
      }
      TMP_8.$$p = null;
      e = ($a = ($b = self).$each_line, $a.$$p = block.$to_proc(), $a).call($b, separator);
      if (block !== false && block !== nil) {
        return self
        } else {
        return e.$to_a()
      };
    };

    return (def['$%'] = function(data) {
      var self = this;

      return self.literal['$%'](data);
    }, nil) && '%';
  })($scope.get('String'), null);
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/match_data"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $gvars = Opal.gvars;

  Opal.add_stubs(['$attr_reader', '$[]', '$raise', '$===', '$inspect', '$to_a', '$coerce_to!']);
  return (function($base, $super) {
    function $MatchData(){};
    var self = $MatchData = $klass($base, $super, 'MatchData', $MatchData);

    var def = self.$$proto, $scope = self.$$scope;

    def.matches = nil;
    self.$attr_reader("post_match", "pre_match", "regexp", "string");

    def.$initialize = function(regexp, match_groups) {
      var self = this;

      $gvars["~"] = self;
      self.regexp = regexp;
      self.begin = match_groups.index;
      self.string = match_groups.input;
      self.pre_match = match_groups.input.slice(0, match_groups.index);
      self.post_match = match_groups.input.slice(match_groups.index + match_groups[0].length);
      self.matches = [];
      
      for (var i = 0, length = match_groups.length; i < length; i++) {
        var group = match_groups[i];

        if (group == null) {
          self.matches.push(nil);
        }
        else {
          self.matches.push(group);
        }
      }
    
    };

    def['$[]'] = function(args) {
      var $a, self = this;

      args = $slice.call(arguments, 0);
      return ($a = self.matches)['$[]'].apply($a, [].concat(args));
    };

    def.$offset = function(n) {
      var self = this;

      
      if (n !== 0) {
        self.$raise($scope.get('ArgumentError'), "MatchData#offset only supports 0th element")
      }
      return [self.begin, self.begin + self.matches[n].length];
    ;
    };

    def['$=='] = function(other) {
      var $a, $b, $c, $d, self = this;

      if ((($a = $scope.get('MatchData')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        return false
      };
      return ($a = ($b = ($c = ($d = self.string == other.string, $d !== false && $d !== nil ?self.regexp.toString() == other.regexp.toString() : $d), $c !== false && $c !== nil ?self.pre_match == other.pre_match : $c), $b !== false && $b !== nil ?self.post_match == other.post_match : $b), $a !== false && $a !== nil ?self.begin == other.begin : $a);
    };

    Opal.defn(self, '$eql?', def['$==']);

    def.$begin = function(n) {
      var self = this;

      
      if (n !== 0) {
        self.$raise($scope.get('ArgumentError'), "MatchData#begin only supports 0th element")
      }
      return self.begin;
    ;
    };

    def.$end = function(n) {
      var self = this;

      
      if (n !== 0) {
        self.$raise($scope.get('ArgumentError'), "MatchData#end only supports 0th element")
      }
      return self.begin + self.matches[n].length;
    ;
    };

    def.$captures = function() {
      var self = this;

      return self.matches.slice(1);
    };

    def.$inspect = function() {
      var self = this;

      
      var str = "#<MatchData " + (self.matches[0]).$inspect();

      for (var i = 1, length = self.matches.length; i < length; i++) {
        str += " " + i + ":" + (self.matches[i]).$inspect();
      }

      return str + ">";
    ;
    };

    def.$length = function() {
      var self = this;

      return self.matches.length;
    };

    Opal.defn(self, '$size', def.$length);

    def.$to_a = function() {
      var self = this;

      return self.matches;
    };

    def.$to_s = function() {
      var self = this;

      return self.matches[0];
    };

    return (def.$values_at = function(args) {
      var self = this;

      args = $slice.call(arguments, 0);
      
      var i, a, index, values = [];

      for (i = 0; i < args.length; i++) {

        if (args[i].$$is_range) {
          a = (args[i]).$to_a();
          a.unshift(i, 1);
          Array.prototype.splice.apply(args, a);
        }

        index = $scope.get('Opal')['$coerce_to!'](args[i], $scope.get('Integer'), "to_int");

        if (index < 0) {
          index += self.matches.length;
          if (index < 0) {
            values.push(nil);
            continue;
          }
        }

        values.push(self.matches[index]);
      }

      return values;
    
    }, nil) && 'values_at';
  })(self, null)
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/numeric"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$coerce', '$===', '$raise', '$class', '$__send__', '$send_coerced', '$coerce_to!', '$-@', '$**', '$respond_to?', '$==', '$enum_for', '$gcd', '$lcm', '$floor', '$%']);
  self.$require("corelib/comparable");
  (function($base, $super) {
    function $Numeric(){};
    var self = $Numeric = $klass($base, $super, 'Numeric', $Numeric);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6;

    self.$include($scope.get('Comparable'));

    def.$$is_number = true;

    def.$__id__ = function() {
      var self = this;

      return (self * 2) + 1;
    };

    Opal.defn(self, '$object_id', def.$__id__);

    def.$coerce = function(other, type) {
      var self = this, $case = nil;

      if (type == null) {
        type = "operation"
      }
      try {
      
      if (other.$$is_number) {
        return [self, other];
      }
      else {
        return other.$coerce(self);
      }
    
      } catch ($err) {if (true) {
        return (function() {$case = type;if ("operation"['$===']($case)) {return self.$raise($scope.get('TypeError'), "" + (other.$class()) + " can't be coerced into Numeric")}else if ("comparison"['$===']($case)) {return self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")}else { return nil }})()
        }else { throw $err; }
      };
    };

    def.$send_coerced = function(method, other) {
      var $a, self = this, type = nil, $case = nil, a = nil, b = nil;

      type = (function() {$case = method;if ("+"['$===']($case) || "-"['$===']($case) || "*"['$===']($case) || "/"['$===']($case) || "%"['$===']($case) || "&"['$===']($case) || "|"['$===']($case) || "^"['$===']($case) || "**"['$===']($case)) {return "operation"}else if (">"['$===']($case) || ">="['$===']($case) || "<"['$===']($case) || "<="['$===']($case) || "<=>"['$===']($case)) {return "comparison"}else { return nil }})();
      $a = Opal.to_ary(self.$coerce(other, type)), a = ($a[0] == null ? nil : $a[0]), b = ($a[1] == null ? nil : $a[1]);
      return a.$__send__(method, b);
    };

    def['$+'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self + other;
      }
      else {
        return self.$send_coerced("+", other);
      }
    
    };

    def['$-'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self - other;
      }
      else {
        return self.$send_coerced("-", other);
      }
    
    };

    def['$*'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self * other;
      }
      else {
        return self.$send_coerced("*", other);
      }
    
    };

    def['$/'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self / other;
      }
      else {
        return self.$send_coerced("/", other);
      }
    
    };

    def['$%'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        if (other < 0 || self < 0) {
          return (self % other + other) % other;
        }
        else {
          return self % other;
        }
      }
      else {
        return self.$send_coerced("%", other);
      }
    
    };

    def['$&'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self & other;
      }
      else {
        return self.$send_coerced("&", other);
      }
    
    };

    def['$|'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self | other;
      }
      else {
        return self.$send_coerced("|", other);
      }
    
    };

    def['$^'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self ^ other;
      }
      else {
        return self.$send_coerced("^", other);
      }
    
    };

    def['$<'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self < other;
      }
      else {
        return self.$send_coerced("<", other);
      }
    
    };

    def['$<='] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self <= other;
      }
      else {
        return self.$send_coerced("<=", other);
      }
    
    };

    def['$>'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self > other;
      }
      else {
        return self.$send_coerced(">", other);
      }
    
    };

    def['$>='] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self >= other;
      }
      else {
        return self.$send_coerced(">=", other);
      }
    
    };

    def['$<=>'] = function(other) {
      var self = this;

      try {
      
      if (other.$$is_number) {
        return self > other ? 1 : (self < other ? -1 : 0);
      }
      else {
        return self.$send_coerced("<=>", other);
      }
    
      } catch ($err) {if (Opal.rescue($err, [$scope.get('ArgumentError')])) {
        return nil
        }else { throw $err; }
      };
    };

    def['$<<'] = function(count) {
      var self = this;

      count = $scope.get('Opal')['$coerce_to!'](count, $scope.get('Integer'), "to_int");
      return count > 0 ? self << count : self >> -count;
    };

    def['$>>'] = function(count) {
      var self = this;

      count = $scope.get('Opal')['$coerce_to!'](count, $scope.get('Integer'), "to_int");
      return count > 0 ? self >> count : self << -count;
    };

    def['$[]'] = function(bit) {
      var self = this, min = nil, max = nil;

      bit = $scope.get('Opal')['$coerce_to!'](bit, $scope.get('Integer'), "to_int");
      min = ((2)['$**'](30))['$-@']();
      max = $rb_minus(((2)['$**'](30)), 1);
      return (bit < min || bit > max) ? 0 : (self >> bit) % 2;
    };

    def['$+@'] = function() {
      var self = this;

      return +self;
    };

    def['$-@'] = function() {
      var self = this;

      return -self;
    };

    def['$~'] = function() {
      var self = this;

      return ~self;
    };

    def['$**'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return Math.pow(self, other);
      }
      else {
        return self.$send_coerced("**", other);
      }
    
    };

    def['$=='] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self == Number(other);
      }
      else if (other['$respond_to?']("==")) {
        return other['$=='](self);
      }
      else {
        return false;
      }
    ;
    };

    def.$abs = function() {
      var self = this;

      return Math.abs(self);
    };

    def.$ceil = function() {
      var self = this;

      return Math.ceil(self);
    };

    def.$chr = function(encoding) {
      var self = this;

      return String.fromCharCode(self);
    };

    def.$conj = function() {
      var self = this;

      return self;
    };

    Opal.defn(self, '$conjugate', def.$conj);

    def.$downto = TMP_1 = function(finish) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("downto", finish)
      };
      
      if (!finish.$$is_number) {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (finish.$class()) + " failed")
      }
      for (var i = self; i >= finish; i--) {
        if (block(i) === $breaker) {
          return $breaker.$v;
        }
      }
    ;
      return self;
    };

    Opal.defn(self, '$eql?', def['$==']);

    def['$equal?'] = function(other) {
      var $a, self = this;

      return ((($a = self['$=='](other)) !== false && $a !== nil) ? $a : isNaN(self) && isNaN(other));
    };

    def['$even?'] = function() {
      var self = this;

      return self % 2 === 0;
    };

    def.$floor = function() {
      var self = this;

      return Math.floor(self);
    };

    def.$gcd = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "not an integer")
      };
      
      var min = Math.abs(self),
          max = Math.abs(other);

      while (min > 0) {
        var tmp = min;

        min = max % min;
        max = tmp;
      }

      return max;
    
    };

    def.$gcdlcm = function(other) {
      var self = this;

      return [self.$gcd(), self.$lcm()];
    };

    def.$hash = function() {
      var self = this;

      return 'Numeric:'+self.toString();
    };

    def['$integer?'] = function() {
      var self = this;

      return self % 1 === 0;
    };

    def['$is_a?'] = TMP_2 = function(klass) {var $zuper = $slice.call(arguments, 0);
      var $a, $b, self = this, $iter = TMP_2.$$p, $yield = $iter || nil;

      TMP_2.$$p = null;
      if ((($a = (($b = klass['$==']($scope.get('Fixnum'))) ? $scope.get('Integer')['$==='](self) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']($scope.get('Integer'))) ? $scope.get('Integer')['$==='](self) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']($scope.get('Float'))) ? $scope.get('Float')['$==='](self) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      return Opal.find_super_dispatcher(self, 'is_a?', TMP_2, $iter).apply(self, $zuper);
    };

    Opal.defn(self, '$kind_of?', def['$is_a?']);

    def['$instance_of?'] = TMP_3 = function(klass) {var $zuper = $slice.call(arguments, 0);
      var $a, $b, self = this, $iter = TMP_3.$$p, $yield = $iter || nil;

      TMP_3.$$p = null;
      if ((($a = (($b = klass['$==']($scope.get('Fixnum'))) ? $scope.get('Integer')['$==='](self) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']($scope.get('Integer'))) ? $scope.get('Integer')['$==='](self) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']($scope.get('Float'))) ? $scope.get('Float')['$==='](self) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      return Opal.find_super_dispatcher(self, 'instance_of?', TMP_3, $iter).apply(self, $zuper);
    };

    def.$lcm = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "not an integer")
      };
      
      if (self == 0 || other == 0) {
        return 0;
      }
      else {
        return Math.abs(self * other / self.$gcd(other));
      }
    
    };

    Opal.defn(self, '$magnitude', def.$abs);

    Opal.defn(self, '$modulo', def['$%']);

    def.$next = function() {
      var self = this;

      return self + 1;
    };

    def['$nonzero?'] = function() {
      var self = this;

      return self == 0 ? nil : self;
    };

    def['$odd?'] = function() {
      var self = this;

      return self % 2 !== 0;
    };

    def.$ord = function() {
      var self = this;

      return self;
    };

    def.$pred = function() {
      var self = this;

      return self - 1;
    };

    def.$round = function(ndigits) {
      var self = this;

      if (ndigits == null) {
        ndigits = 0
      }
      
      var scale = Math.pow(10, ndigits);
      return Math.round(self * scale) / scale;
    
    };

    def.$step = TMP_4 = function(limit, step) {
      var $a, self = this, $iter = TMP_4.$$p, block = $iter || nil;

      if (step == null) {
        step = 1
      }
      TMP_4.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("step", limit, step)
      };
      if ((($a = step == 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "step cannot be 0")};
      
      var value = self;

      if (step > 0) {
        while (value <= limit) {
          block(value);
          value += step;
        }
      }
      else {
        while (value >= limit) {
          block(value);
          value += step;
        }
      }
    
      return self;
    };

    Opal.defn(self, '$succ', def.$next);

    def.$times = TMP_5 = function() {
      var self = this, $iter = TMP_5.$$p, block = $iter || nil;

      TMP_5.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("times")
      };
      
      for (var i = 0; i < self; i++) {
        if (block(i) === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def.$to_f = function() {
      var self = this;

      return self;
    };

    def.$to_i = function() {
      var self = this;

      return parseInt(self);
    };

    Opal.defn(self, '$to_int', def.$to_i);

    def.$to_s = function(base) {
      var $a, $b, self = this;

      if (base == null) {
        base = 10
      }
      if ((($a = ((($b = $rb_lt(base, 2)) !== false && $b !== nil) ? $b : $rb_gt(base, 36))) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "base must be between 2 and 36")};
      return self.toString(base);
    };

    Opal.defn(self, '$inspect', def.$to_s);

    def.$divmod = function(rhs) {
      var self = this, q = nil, r = nil;

      q = ($rb_divide(self, rhs)).$floor();
      r = self['$%'](rhs);
      return [q, r];
    };

    def.$upto = TMP_6 = function(finish) {
      var self = this, $iter = TMP_6.$$p, block = $iter || nil;

      TMP_6.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("upto", finish)
      };
      
      if (!finish.$$is_number) {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (finish.$class()) + " failed")
      }
      for (var i = self; i <= finish; i++) {
        if (block(i) === $breaker) {
          return $breaker.$v;
        }
      }
    ;
      return self;
    };

    def['$zero?'] = function() {
      var self = this;

      return self == 0;
    };

    def.$size = function() {
      var self = this;

      return 4;
    };

    def['$nan?'] = function() {
      var self = this;

      return isNaN(self);
    };

    def['$finite?'] = function() {
      var self = this;

      return self != Infinity && self != -Infinity;
    };

    def['$infinite?'] = function() {
      var self = this;

      
      if (self == Infinity) {
        return +1;
      }
      else if (self == -Infinity) {
        return -1;
      }
      else {
        return nil;
      }
    
    };

    def['$positive?'] = function() {
      var self = this;

      return 1 / self > 0;
    };

    return (def['$negative?'] = function() {
      var self = this;

      return 1 / self < 0;
    }, nil) && 'negative?';
  })(self, null);
  Opal.cdecl($scope, 'Fixnum', $scope.get('Numeric'));
  (function($base, $super) {
    function $Integer(){};
    var self = $Integer = $klass($base, $super, 'Integer', $Integer);

    var def = self.$$proto, $scope = self.$$scope;

    return (Opal.defs(self, '$===', function(other) {
      var self = this;

      
      if (!other.$$is_number) {
        return false;
      }

      return (other % 1) === 0;
    
    }), nil) && '==='
  })(self, $scope.get('Numeric'));
  return (function($base, $super) {
    function $Float(){};
    var self = $Float = $klass($base, $super, 'Float', $Float);

    var def = self.$$proto, $scope = self.$$scope, $a;

    Opal.defs(self, '$===', function(other) {
      var self = this;

      return !!other.$$is_number;
    });

    Opal.cdecl($scope, 'INFINITY', Infinity);

    Opal.cdecl($scope, 'NAN', NaN);

    if ((($a = (typeof(Number.EPSILON) !== "undefined")) !== nil && (!$a.$$is_boolean || $a == true))) {
      return Opal.cdecl($scope, 'EPSILON', Number.EPSILON)
      } else {
      return Opal.cdecl($scope, 'EPSILON', 2.2204460492503130808472633361816E-16)
    };
  })(self, $scope.get('Numeric'));
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/complex"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  return (function($base, $super) {
    function $Complex(){};
    var self = $Complex = $klass($base, $super, 'Complex', $Complex);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Numeric'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/rational"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  return (function($base, $super) {
    function $Rational(){};
    var self = $Rational = $klass($base, $super, 'Rational', $Rational);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Numeric'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/proc"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$raise']);
  return (function($base, $super) {
    function $Proc(){};
    var self = $Proc = $klass($base, $super, 'Proc', $Proc);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2;

    def.$$is_proc = true;

    def.$$is_lambda = false;

    Opal.defs(self, '$new', TMP_1 = function() {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        self.$raise($scope.get('ArgumentError'), "tried to create a Proc object without a block")
      };
      return block;
    });

    def.$call = TMP_2 = function(args) {
      var self = this, $iter = TMP_2.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_2.$$p = null;
      
      if (block !== nil) {
        self.$$p = block;
      }

      var result;

      if (self.$$is_lambda) {
        result = self.apply(null, args);
      }
      else {
        result = Opal.yieldX(self, args);
      }

      if (result === $breaker) {
        return $breaker.$v;
      }

      return result;
    
    };

    Opal.defn(self, '$[]', def.$call);

    def.$to_proc = function() {
      var self = this;

      return self;
    };

    def['$lambda?'] = function() {
      var self = this;

      return !!self.$$is_lambda;
    };

    return (def.$arity = function() {
      var self = this;

      return self.length;
    }, nil) && 'arity';
  })(self, null)
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/method"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$attr_reader', '$class', '$arity', '$new', '$name']);
  (function($base, $super) {
    function $Method(){};
    var self = $Method = $klass($base, $super, 'Method', $Method);

    var def = self.$$proto, $scope = self.$$scope, TMP_1;

    def.method = def.receiver = def.owner = def.name = def.obj = nil;
    self.$attr_reader("owner", "receiver", "name");

    def.$initialize = function(receiver, method, name) {
      var self = this;

      self.receiver = receiver;
      self.owner = receiver.$class();
      self.name = name;
      return self.method = method;
    };

    def.$arity = function() {
      var self = this;

      return self.method.$arity();
    };

    def.$call = TMP_1 = function(args) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_1.$$p = null;
      
      self.method.$$p = block;

      return self.method.apply(self.receiver, args);
    ;
    };

    Opal.defn(self, '$[]', def.$call);

    def.$unbind = function() {
      var self = this;

      return $scope.get('UnboundMethod').$new(self.owner, self.method, self.name);
    };

    def.$to_proc = function() {
      var self = this;

      return self.method;
    };

    return (def.$inspect = function() {
      var self = this;

      return "#<Method: " + (self.obj.$class()) + "#" + (self.name) + "}>";
    }, nil) && 'inspect';
  })(self, null);
  return (function($base, $super) {
    function $UnboundMethod(){};
    var self = $UnboundMethod = $klass($base, $super, 'UnboundMethod', $UnboundMethod);

    var def = self.$$proto, $scope = self.$$scope;

    def.method = def.name = def.owner = nil;
    self.$attr_reader("owner", "name");

    def.$initialize = function(owner, method, name) {
      var self = this;

      self.owner = owner;
      self.method = method;
      return self.name = name;
    };

    def.$arity = function() {
      var self = this;

      return self.method.$arity();
    };

    def.$bind = function(object) {
      var self = this;

      return $scope.get('Method').$new(object, self.method, self.name);
    };

    return (def.$inspect = function() {
      var self = this;

      return "#<UnboundMethod: " + (self.owner.$name()) + "#" + (self.name) + ">";
    }, nil) && 'inspect';
  })(self, null);
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/range"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_le(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs <= rhs : lhs['$<='](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$attr_reader', '$<=>', '$raise', '$include?', '$enum_for', '$succ', '$!', '$==', '$===', '$exclude_end?', '$eql?', '$begin', '$end', '$abs', '$to_i', '$inspect']);
  self.$require("corelib/enumerable");
  return (function($base, $super) {
    function $Range(){};
    var self = $Range = $klass($base, $super, 'Range', $Range);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3;

    def.begin = def.exclude = def.end = nil;
    self.$include($scope.get('Enumerable'));

    def.$$is_range = true;

    self.$attr_reader("begin", "end");

    def.$initialize = function(first, last, exclude) {
      var $a, self = this;

      if (exclude == null) {
        exclude = false
      }
      if ((($a = first['$<=>'](last)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'))
      };
      self.begin = first;
      self.end = last;
      return self.exclude = exclude;
    };

    def['$=='] = function(other) {
      var self = this;

      
      if (!other.$$is_range) {
        return false;
      }

      return self.exclude === other.exclude &&
             self.begin   ==  other.begin &&
             self.end     ==  other.end;
    
    };

    def['$==='] = function(value) {
      var self = this;

      return self['$include?'](value);
    };

    def['$cover?'] = function(value) {
      var $a, $b, self = this;

      return (($a = $rb_le(self.begin, value)) ? ((function() {if ((($b = self.exclude) !== nil && (!$b.$$is_boolean || $b == true))) {
        return $rb_lt(value, self.end)
        } else {
        return $rb_le(value, self.end)
      }; return nil; })()) : $a);
    };

    def.$each = TMP_1 = function() {
      var $a, $b, self = this, $iter = TMP_1.$$p, block = $iter || nil, current = nil, last = nil;

      TMP_1.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each")
      };
      current = self.begin;
      last = self.end;
      while ($rb_lt(current, last)) {
      if (Opal.yield1(block, current) === $breaker) return $breaker.$v;
      current = current.$succ();};
      if ((($a = ($b = self.exclude['$!'](), $b !== false && $b !== nil ?current['$=='](last) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        if (Opal.yield1(block, current) === $breaker) return $breaker.$v};
      return self;
    };

    def['$eql?'] = function(other) {
      var $a, $b, self = this;

      if ((($a = $scope.get('Range')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        return false
      };
      return ($a = ($b = self.exclude['$==='](other['$exclude_end?']()), $b !== false && $b !== nil ?self.begin['$eql?'](other.$begin()) : $b), $a !== false && $a !== nil ?self.end['$eql?'](other.$end()) : $a);
    };

    def['$exclude_end?'] = function() {
      var self = this;

      return self.exclude;
    };

    Opal.defn(self, '$first', def.$begin);

    Opal.defn(self, '$include?', def['$cover?']);

    Opal.defn(self, '$last', def.$end);

    def.$max = TMP_2 = function() {var $zuper = $slice.call(arguments, 0);
      var self = this, $iter = TMP_2.$$p, $yield = $iter || nil;

      TMP_2.$$p = null;
      if (($yield !== nil)) {
        return Opal.find_super_dispatcher(self, 'max', TMP_2, $iter).apply(self, $zuper)
        } else {
        return self.exclude ? self.end - 1 : self.end;
      };
    };

    Opal.defn(self, '$member?', def['$cover?']);

    def.$min = TMP_3 = function() {var $zuper = $slice.call(arguments, 0);
      var self = this, $iter = TMP_3.$$p, $yield = $iter || nil;

      TMP_3.$$p = null;
      if (($yield !== nil)) {
        return Opal.find_super_dispatcher(self, 'min', TMP_3, $iter).apply(self, $zuper)
        } else {
        return self.begin
      };
    };

    Opal.defn(self, '$member?', def['$include?']);

    def.$size = function() {
      var $a, $b, self = this, _begin = nil, _end = nil, infinity = nil;

      _begin = self.begin;
      _end = self.end;
      if ((($a = self.exclude) !== nil && (!$a.$$is_boolean || $a == true))) {
        _end = $rb_minus(_end, 1)};
      if ((($a = ($b = $scope.get('Numeric')['$==='](_begin), $b !== false && $b !== nil ?$scope.get('Numeric')['$==='](_end) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        return nil
      };
      if ($rb_lt(_end, _begin)) {
        return 0};
      infinity = (($scope.get('Float')).$$scope.get('INFINITY'));
      if ((($a = ((($b = infinity['$=='](_begin.$abs())) !== false && $b !== nil) ? $b : _end.$abs()['$=='](infinity))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return infinity};
      return ((Math.abs(_end - _begin) + 1)).$to_i();
    };

    def.$step = function(n) {
      var self = this;

      if (n == null) {
        n = 1
      }
      return self.$raise($scope.get('NotImplementedError'));
    };

    def.$to_s = function() {
      var self = this;

      return self.begin.$inspect() + (self.exclude ? '...' : '..') + self.end.$inspect();
    };

    return Opal.defn(self, '$inspect', def.$to_s);
  })(self, null);
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/time"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_le(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs <= rhs : lhs['$<='](rhs);
  }
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $range = Opal.range;

  Opal.add_stubs(['$require', '$include', '$kind_of?', '$to_i', '$coerce_to', '$between?', '$raise', '$new', '$compact', '$nil?', '$===', '$<=>', '$to_f', '$strftime', '$is_a?', '$zero?', '$wday', '$utc?', '$warn', '$year', '$mon', '$day', '$yday', '$hour', '$min', '$sec', '$rjust', '$ljust', '$zone', '$to_s', '$[]', '$cweek_cyear', '$month', '$isdst', '$private', '$!', '$==', '$ceil']);
  self.$require("corelib/comparable");
  return (function($base, $super) {
    function $Time(){};
    var self = $Time = $klass($base, $super, 'Time', $Time);

    var def = self.$$proto, $scope = self.$$scope;

    def.tz_offset = nil;
    self.$include($scope.get('Comparable'));

    
    var days_of_week = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
        short_days   = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        short_months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
        long_months  = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  ;

    Opal.defs(self, '$at', function(seconds, frac) {
      var self = this;

      if (frac == null) {
        frac = 0
      }
      return new Date(seconds * 1000 + frac);
    });

    Opal.defs(self, '$new', function(year, month, day, hour, minute, second, utc_offset) {
      var self = this;

      
      switch (arguments.length) {
        case 1:
          return new Date(year, 0);

        case 2:
          return new Date(year, month - 1);

        case 3:
          return new Date(year, month - 1, day);

        case 4:
          return new Date(year, month - 1, day, hour);

        case 5:
          return new Date(year, month - 1, day, hour, minute);

        case 6:
          return new Date(year, month - 1, day, hour, minute, second);

        case 7:
          return new Date(year, month - 1, day, hour, minute, second);

        default:
          return new Date();
      }
    
    });

    Opal.defs(self, '$local', function(year, month, day, hour, minute, second, millisecond) {
      var $a, self = this;

      if (month == null) {
        month = nil
      }
      if (day == null) {
        day = nil
      }
      if (hour == null) {
        hour = nil
      }
      if (minute == null) {
        minute = nil
      }
      if (second == null) {
        second = nil
      }
      if (millisecond == null) {
        millisecond = nil
      }
      if ((($a = arguments.length === 10) !== nil && (!$a.$$is_boolean || $a == true))) {
        
        var args = $slice.call(arguments).reverse();

        second = args[9];
        minute = args[8];
        hour   = args[7];
        day    = args[6];
        month  = args[5];
        year   = args[4];
      };
      year = (function() {if ((($a = year['$kind_of?']($scope.get('String'))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return year.$to_i()
        } else {
        return $scope.get('Opal').$coerce_to(year, $scope.get('Integer'), "to_int")
      }; return nil; })();
      month = (function() {if ((($a = month['$kind_of?']($scope.get('String'))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return month.$to_i()
        } else {
        return $scope.get('Opal').$coerce_to(((($a = month) !== false && $a !== nil) ? $a : 1), $scope.get('Integer'), "to_int")
      }; return nil; })();
      if ((($a = month['$between?'](1, 12)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "month out of range: " + (month))
      };
      day = (function() {if ((($a = day['$kind_of?']($scope.get('String'))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return day.$to_i()
        } else {
        return $scope.get('Opal').$coerce_to(((($a = day) !== false && $a !== nil) ? $a : 1), $scope.get('Integer'), "to_int")
      }; return nil; })();
      if ((($a = day['$between?'](1, 31)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "day out of range: " + (day))
      };
      hour = (function() {if ((($a = hour['$kind_of?']($scope.get('String'))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return hour.$to_i()
        } else {
        return $scope.get('Opal').$coerce_to(((($a = hour) !== false && $a !== nil) ? $a : 0), $scope.get('Integer'), "to_int")
      }; return nil; })();
      if ((($a = hour['$between?'](0, 24)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "hour out of range: " + (hour))
      };
      minute = (function() {if ((($a = minute['$kind_of?']($scope.get('String'))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return minute.$to_i()
        } else {
        return $scope.get('Opal').$coerce_to(((($a = minute) !== false && $a !== nil) ? $a : 0), $scope.get('Integer'), "to_int")
      }; return nil; })();
      if ((($a = minute['$between?'](0, 59)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "minute out of range: " + (minute))
      };
      second = (function() {if ((($a = second['$kind_of?']($scope.get('String'))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return second.$to_i()
        } else {
        return $scope.get('Opal').$coerce_to(((($a = second) !== false && $a !== nil) ? $a : 0), $scope.get('Integer'), "to_int")
      }; return nil; })();
      if ((($a = second['$between?'](0, 59)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "second out of range: " + (second))
      };
      return ($a = self).$new.apply($a, [].concat([year, month, day, hour, minute, second].$compact()));
    });

    Opal.defs(self, '$gm', function(year, month, day, hour, minute, second, utc_offset) {
      var $a, self = this;

      if ((($a = year['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('TypeError'), "missing year (got nil)")};
      
      if (month > 12 || day > 31 || hour > 24 || minute > 59 || second > 59) {
        self.$raise($scope.get('ArgumentError'));
      }

      var date = new Date(Date.UTC(year, (month || 1) - 1, (day || 1), (hour || 0), (minute || 0), (second || 0)));
      date.tz_offset = 0
      return date;
    ;
    });

    (function(self) {
      var $scope = self.$$scope, def = self.$$proto;

      self.$$proto.$mktime = self.$$proto.$local;
      return self.$$proto.$utc = self.$$proto.$gm;
    })(self.$singleton_class());

    Opal.defs(self, '$now', function() {
      var self = this;

      return new Date();
    });

    def['$+'] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Time')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('TypeError'), "time + time?")};
      other = $scope.get('Opal').$coerce_to(other, $scope.get('Integer'), "to_int");
      
      var result           = new Date(self.getTime() + (other * 1000));
          result.tz_offset = self.tz_offset;

      return result;
    
    };

    def['$-'] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Time')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return (self.getTime() - other.getTime()) / 1000};
      other = $scope.get('Opal').$coerce_to(other, $scope.get('Integer'), "to_int");
      
      var result           = new Date(self.getTime() - (other * 1000));
          result.tz_offset = self.tz_offset;

      return result;
    
    };

    def['$<=>'] = function(other) {
      var self = this;

      return self.$to_f()['$<=>'](other.$to_f());
    };

    def['$=='] = function(other) {
      var self = this;

      return self.$to_f() === other.$to_f();
    };

    def.$asctime = function() {
      var self = this;

      return self.$strftime("%a %b %e %H:%M:%S %Y");
    };

    Opal.defn(self, '$ctime', def.$asctime);

    def.$day = function() {
      var self = this;

      
      if (self.tz_offset === 0) {
        return self.getUTCDate();
      }
      else {
        return self.getDate();
      }
    ;
    };

    def.$yday = function() {
      var self = this;

      
      // http://javascript.about.com/library/bldayyear.htm
      var onejan = new Date(self.getFullYear(), 0, 1);
      return Math.ceil((self - onejan) / 86400000);
    
    };

    def.$isdst = function() {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'));
    };

    def['$eql?'] = function(other) {
      var $a, self = this;

      return ($a = other['$is_a?']($scope.get('Time')), $a !== false && $a !== nil ?(self['$<=>'](other))['$zero?']() : $a);
    };

    def['$friday?'] = function() {
      var self = this;

      return self.$wday() == 5;
    };

    def.$hour = function() {
      var self = this;

      
      if (self.tz_offset === 0) {
        return self.getUTCHours();
      }
      else {
        return self.getHours();
      }
    ;
    };

    def.$inspect = function() {
      var $a, self = this;

      if ((($a = self['$utc?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.$strftime("%Y-%m-%d %H:%M:%S UTC")
        } else {
        return self.$strftime("%Y-%m-%d %H:%M:%S %z")
      };
    };

    Opal.defn(self, '$mday', def.$day);

    def.$min = function() {
      var self = this;

      
      if (self.tz_offset === 0) {
        return self.getUTCMinutes();
      }
      else {
        return self.getMinutes();
      }
    ;
    };

    def.$mon = function() {
      var self = this;

      
      if (self.tz_offset === 0) {
        return self.getUTCMonth() + 1;
      }
      else {
        return self.getMonth() + 1;
      }
    ;
    };

    def['$monday?'] = function() {
      var self = this;

      return self.$wday() == 1;
    };

    Opal.defn(self, '$month', def.$mon);

    def['$saturday?'] = function() {
      var self = this;

      return self.$wday() == 6;
    };

    def.$sec = function() {
      var self = this;

      
      if (self.tz_offset === 0) {
        return self.getUTCSeconds();
      }
      else {
        return self.getSeconds();
      }
    ;
    };

    def.$usec = function() {
      var self = this;

      self.$warn("Microseconds are not supported");
      return 0;
    };

    def.$zone = function() {
      var self = this;

      
      var string = self.toString(),
          result;

      if (string.indexOf('(') == -1) {
        result = string.match(/[A-Z]{3,4}/)[0];
      }
      else {
        result = string.match(/\([^)]+\)/)[0].match(/[A-Z]/g).join('');
      }

      if (result == "GMT" && /(GMT\W*\d{4})/.test(string)) {
        return RegExp.$1;
      }
      else {
        return result;
      }
    
    };

    def.$getgm = function() {
      var self = this;

      
      var result           = new Date(self.getTime());
          result.tz_offset = 0;

      return result;
    
    };

    def['$gmt?'] = function() {
      var self = this;

      return self.tz_offset === 0;
    };

    def.$gmt_offset = function() {
      var self = this;

      return -self.getTimezoneOffset() * 60;
    };

    def.$strftime = function(format) {
      var self = this;

      
      return format.replace(/%([\-_#^0]*:{0,2})(\d+)?([EO]*)(.)/g, function(full, flags, width, _, conv) {
        var result = "",
            width  = parseInt(width),
            zero   = flags.indexOf('0') !== -1,
            pad    = flags.indexOf('-') === -1,
            blank  = flags.indexOf('_') !== -1,
            upcase = flags.indexOf('^') !== -1,
            invert = flags.indexOf('#') !== -1,
            colons = (flags.match(':') || []).length;

        if (zero && blank) {
          if (flags.indexOf('0') < flags.indexOf('_')) {
            zero = false;
          }
          else {
            blank = false;
          }
        }

        switch (conv) {
          case 'Y':
            result += self.$year();
            break;

          case 'C':
            zero    = !blank;
            result += Math.round(self.$year() / 100);
            break;

          case 'y':
            zero    = !blank;
            result += (self.$year() % 100);
            break;

          case 'm':
            zero    = !blank;
            result += self.$mon();
            break;

          case 'B':
            result += long_months[self.$mon() - 1];
            break;

          case 'b':
          case 'h':
            blank   = !zero;
            result += short_months[self.$mon() - 1];
            break;

          case 'd':
            zero    = !blank
            result += self.$day();
            break;

          case 'e':
            blank   = !zero
            result += self.$day();
            break;

          case 'j':
            result += self.$yday();
            break;

          case 'H':
            zero    = !blank;
            result += self.$hour();
            break;

          case 'k':
            blank   = !zero;
            result += self.$hour();
            break;

          case 'I':
            zero    = !blank;
            result += (self.$hour() % 12 || 12);
            break;

          case 'l':
            blank   = !zero;
            result += (self.$hour() % 12 || 12);
            break;

          case 'P':
            result += (self.$hour() >= 12 ? "pm" : "am");
            break;

          case 'p':
            result += (self.$hour() >= 12 ? "PM" : "AM");
            break;

          case 'M':
            zero    = !blank;
            result += self.$min();
            break;

          case 'S':
            zero    = !blank;
            result += self.$sec()
            break;

          case 'L':
            zero    = !blank;
            width   = isNaN(width) ? 3 : width;
            result += self.getMilliseconds();
            break;

          case 'N':
            width   = isNaN(width) ? 9 : width;
            result += (self.getMilliseconds().toString()).$rjust(3, "0");
            result  = (result).$ljust(width, "0");
            break;

          case 'z':
            var offset  = self.getTimezoneOffset(),
                hours   = Math.floor(Math.abs(offset) / 60),
                minutes = Math.abs(offset) % 60;

            result += offset < 0 ? "+" : "-";
            result += hours < 10 ? "0" : "";
            result += hours;

            if (colons > 0) {
              result += ":";
            }

            result += minutes < 10 ? "0" : "";
            result += minutes;

            if (colons > 1) {
              result += ":00";
            }

            break;

          case 'Z':
            result += self.$zone();
            break;

          case 'A':
            result += days_of_week[self.$wday()];
            break;

          case 'a':
            result += short_days[self.$wday()];
            break;

          case 'u':
            result += (self.$wday() + 1);
            break;

          case 'w':
            result += self.$wday();
            break;

          case 'V':
            result += self.$cweek_cyear()['$[]'](0).$to_s().$rjust(2, "0");
            break;

          case 'G':
            result += self.$cweek_cyear()['$[]'](1);
            break;

          case 'g':
            result += self.$cweek_cyear()['$[]'](1)['$[]']($range(-2, -1, false));
            break;

          case 's':
            result += self.$to_i();
            break;

          case 'n':
            result += "\n";
            break;

          case 't':
            result += "\t";
            break;

          case '%':
            result += "%";
            break;

          case 'c':
            result += self.$strftime("%a %b %e %T %Y");
            break;

          case 'D':
          case 'x':
            result += self.$strftime("%m/%d/%y");
            break;

          case 'F':
            result += self.$strftime("%Y-%m-%d");
            break;

          case 'v':
            result += self.$strftime("%e-%^b-%4Y");
            break;

          case 'r':
            result += self.$strftime("%I:%M:%S %p");
            break;

          case 'R':
            result += self.$strftime("%H:%M");
            break;

          case 'T':
          case 'X':
            result += self.$strftime("%H:%M:%S");
            break;

          default:
            return full;
        }

        if (upcase) {
          result = result.toUpperCase();
        }

        if (invert) {
          result = result.replace(/[A-Z]/, function(c) { c.toLowerCase() }).
                          replace(/[a-z]/, function(c) { c.toUpperCase() });
        }

        if (pad && (zero || blank)) {
          result = (result).$rjust(isNaN(width) ? 2 : width, blank ? " " : "0");
        }

        return result;
      });
    
    };

    def['$sunday?'] = function() {
      var self = this;

      return self.$wday() == 0;
    };

    def['$thursday?'] = function() {
      var self = this;

      return self.$wday() == 4;
    };

    def.$to_a = function() {
      var self = this;

      return [self.$sec(), self.$min(), self.$hour(), self.$day(), self.$month(), self.$year(), self.$wday(), self.$yday(), self.$isdst(), self.$zone()];
    };

    def.$to_f = function() {
      var self = this;

      return self.getTime() / 1000;
    };

    def.$to_i = function() {
      var self = this;

      return parseInt(self.getTime() / 1000);
    };

    Opal.defn(self, '$to_s', def.$inspect);

    def['$tuesday?'] = function() {
      var self = this;

      return self.$wday() == 2;
    };

    Opal.defn(self, '$utc?', def['$gmt?']);

    Opal.defn(self, '$utc_offset', def.$gmt_offset);

    def.$wday = function() {
      var self = this;

      
      if (self.tz_offset === 0) {
        return self.getUTCDay();
      }
      else {
        return self.getDay();
      }
    ;
    };

    def['$wednesday?'] = function() {
      var self = this;

      return self.$wday() == 3;
    };

    def.$year = function() {
      var self = this;

      
      if (self.tz_offset === 0) {
        return self.getUTCFullYear();
      }
      else {
        return self.getFullYear();
      }
    ;
    };

    self.$private("cweek_cyear");

    return (def.$cweek_cyear = function() {
      var $a, $b, self = this, jan01 = nil, jan01_wday = nil, first_monday = nil, year = nil, offset = nil, week = nil, dec31 = nil, dec31_wday = nil;

      jan01 = $scope.get('Time').$new(self.$year(), 1, 1);
      jan01_wday = jan01.$wday();
      first_monday = 0;
      year = self.$year();
      if ((($a = (($b = $rb_le(jan01_wday, 4)) ? jan01_wday['$=='](0)['$!']() : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        offset = $rb_minus(jan01_wday, 1)
        } else {
        offset = $rb_minus($rb_minus(jan01_wday, 7), 1);
        if (offset['$=='](-8)) {
          offset = -1};
      };
      week = ($rb_divide(($rb_plus(self.$yday(), offset)), 7.0)).$ceil();
      if ($rb_le(week, 0)) {
        return $scope.get('Time').$new($rb_minus(self.$year(), 1), 12, 31).$cweek_cyear()
      } else if (week['$=='](53)) {
        dec31 = $scope.get('Time').$new(self.$year(), 12, 31);
        dec31_wday = dec31.$wday();
        if ((($a = (($b = $rb_le(dec31_wday, 3)) ? dec31_wday['$=='](0)['$!']() : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
          week = 1;
          year = $rb_plus(year, 1);};};
      return [week, year];
    }, nil) && 'cweek_cyear';
  })(self, null);
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/struct"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  function $rb_ge(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs >= rhs : lhs['$>='](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $hash2 = Opal.hash2;

  Opal.add_stubs(['$require', '$include', '$==', '$[]', '$upcase', '$const_set', '$new', '$unshift', '$each', '$define_struct_attribute', '$instance_eval', '$to_proc', '$raise', '$<<', '$members', '$attr_accessor', '$each_with_index', '$instance_variable_set', '$class', '$===', '$-@', '$size', '$include?', '$to_sym', '$instance_variable_get', '$enum_for', '$hash', '$all?', '$length', '$map', '$join', '$inspect', '$each_pair', '$inject', '$[]=', '$flatten', '$to_a']);
  self.$require("corelib/enumerable");
  return (function($base, $super) {
    function $Struct(){};
    var self = $Struct = $klass($base, $super, 'Struct', $Struct);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_6, TMP_8;

    self.$include($scope.get('Enumerable'));

    Opal.defs(self, '$new', TMP_1 = function(name, args) {var $zuper = $slice.call(arguments, 0);
      var $a, $b, $c, TMP_2, self = this, $iter = TMP_1.$$p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_1.$$p = null;
      if (self['$==']($scope.get('Struct'))) {
        } else {
        return Opal.find_super_dispatcher(self, 'new', TMP_1, $iter, $Struct).apply(self, $zuper)
      };
      if (name['$[]'](0)['$=='](name['$[]'](0).$upcase())) {
        return $scope.get('Struct').$const_set(name, ($a = self).$new.apply($a, [].concat(args)))
        } else {
        args.$unshift(name);
        return ($b = ($c = $scope.get('Class')).$new, $b.$$p = (TMP_2 = function(){var self = TMP_2.$$s || this, $a, $b, TMP_3, $c;

        ($a = ($b = args).$each, $a.$$p = (TMP_3 = function(arg){var self = TMP_3.$$s || this;
if (arg == null) arg = nil;
          return self.$define_struct_attribute(arg)}, TMP_3.$$s = self, TMP_3), $a).call($b);
          if (block !== false && block !== nil) {
            return ($a = ($c = self).$instance_eval, $a.$$p = block.$to_proc(), $a).call($c)
            } else {
            return nil
          };}, TMP_2.$$s = self, TMP_2), $b).call($c, self);
      };
    });

    Opal.defs(self, '$define_struct_attribute', function(name) {
      var self = this;

      if (self['$==']($scope.get('Struct'))) {
        self.$raise($scope.get('ArgumentError'), "you cannot define attributes to the Struct class")};
      self.$members()['$<<'](name);
      return self.$attr_accessor(name);
    });

    Opal.defs(self, '$members', function() {
      var $a, self = this;
      if (self.members == null) self.members = nil;

      if (self['$==']($scope.get('Struct'))) {
        self.$raise($scope.get('ArgumentError'), "the Struct class has no members")};
      return ((($a = self.members) !== false && $a !== nil) ? $a : self.members = []);
    });

    Opal.defs(self, '$inherited', function(klass) {
      var $a, $b, TMP_4, self = this, members = nil;
      if (self.members == null) self.members = nil;

      members = self.members;
      return ($a = ($b = klass).$instance_eval, $a.$$p = (TMP_4 = function(){var self = TMP_4.$$s || this;

      return self.members = members}, TMP_4.$$s = self, TMP_4), $a).call($b);
    });

    (function(self) {
      var $scope = self.$$scope, def = self.$$proto;

      return self.$$proto['$[]'] = self.$$proto.$new
    })(self.$singleton_class());

    def.$initialize = function(args) {
      var $a, $b, TMP_5, self = this;

      args = $slice.call(arguments, 0);
      return ($a = ($b = self.$members()).$each_with_index, $a.$$p = (TMP_5 = function(name, index){var self = TMP_5.$$s || this;
if (name == null) name = nil;if (index == null) index = nil;
      return self.$instance_variable_set("@" + (name), args['$[]'](index))}, TMP_5.$$s = self, TMP_5), $a).call($b);
    };

    def.$members = function() {
      var self = this;

      return self.$class().$members();
    };

    def['$[]'] = function(name) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](name)) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ($rb_lt(name, self.$members().$size()['$-@']())) {
          self.$raise($scope.get('IndexError'), "offset " + (name) + " too small for struct(size:" + (self.$members().$size()) + ")")};
        if ($rb_ge(name, self.$members().$size())) {
          self.$raise($scope.get('IndexError'), "offset " + (name) + " too large for struct(size:" + (self.$members().$size()) + ")")};
        name = self.$members()['$[]'](name);
      } else if ((($a = $scope.get('String')['$==='](name)) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ((($a = self.$members()['$include?'](name.$to_sym())) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.$raise($scope.get('NameError'), "no member '" + (name) + "' in struct")
        }
        } else {
        self.$raise($scope.get('TypeError'), "no implicit conversion of " + (name.$class()) + " into Integer")
      };
      return self.$instance_variable_get("@" + (name));
    };

    def['$[]='] = function(name, value) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](name)) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ($rb_lt(name, self.$members().$size()['$-@']())) {
          self.$raise($scope.get('IndexError'), "offset " + (name) + " too small for struct(size:" + (self.$members().$size()) + ")")};
        if ($rb_ge(name, self.$members().$size())) {
          self.$raise($scope.get('IndexError'), "offset " + (name) + " too large for struct(size:" + (self.$members().$size()) + ")")};
        name = self.$members()['$[]'](name);
      } else if ((($a = $scope.get('String')['$==='](name)) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ((($a = self.$members()['$include?'](name.$to_sym())) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.$raise($scope.get('NameError'), "no member '" + (name) + "' in struct")
        }
        } else {
        self.$raise($scope.get('TypeError'), "no implicit conversion of " + (name.$class()) + " into Integer")
      };
      return self.$instance_variable_set("@" + (name), value);
    };

    def.$each = TMP_6 = function() {
      var $a, $b, TMP_7, self = this, $iter = TMP_6.$$p, $yield = $iter || nil;

      TMP_6.$$p = null;
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("each")
      };
      ($a = ($b = self.$members()).$each, $a.$$p = (TMP_7 = function(name){var self = TMP_7.$$s || this, $a;
if (name == null) name = nil;
      return $a = Opal.yield1($yield, self['$[]'](name)), $a === $breaker ? $a : $a}, TMP_7.$$s = self, TMP_7), $a).call($b);
      return self;
    };

    def.$each_pair = TMP_8 = function() {
      var $a, $b, TMP_9, self = this, $iter = TMP_8.$$p, $yield = $iter || nil;

      TMP_8.$$p = null;
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("each_pair")
      };
      ($a = ($b = self.$members()).$each, $a.$$p = (TMP_9 = function(name){var self = TMP_9.$$s || this, $a;
if (name == null) name = nil;
      return $a = Opal.yieldX($yield, [name, self['$[]'](name)]), $a === $breaker ? $a : $a}, TMP_9.$$s = self, TMP_9), $a).call($b);
      return self;
    };

    def['$eql?'] = function(other) {
      var $a, $b, $c, TMP_10, self = this;

      return ((($a = self.$hash()['$=='](other.$hash())) !== false && $a !== nil) ? $a : ($b = ($c = other.$each_with_index())['$all?'], $b.$$p = (TMP_10 = function(object, index){var self = TMP_10.$$s || this;
if (object == null) object = nil;if (index == null) index = nil;
      return self['$[]'](self.$members()['$[]'](index))['$=='](object)}, TMP_10.$$s = self, TMP_10), $b).call($c));
    };

    def.$length = function() {
      var self = this;

      return self.$members().$length();
    };

    Opal.defn(self, '$size', def.$length);

    def.$to_a = function() {
      var $a, $b, TMP_11, self = this;

      return ($a = ($b = self.$members()).$map, $a.$$p = (TMP_11 = function(name){var self = TMP_11.$$s || this;
if (name == null) name = nil;
      return self['$[]'](name)}, TMP_11.$$s = self, TMP_11), $a).call($b);
    };

    Opal.defn(self, '$values', def.$to_a);

    def.$inspect = function() {
      var $a, $b, TMP_12, self = this, result = nil;

      result = "#<struct ";
      if (self.$class()['$==']($scope.get('Struct'))) {
        result = $rb_plus(result, "" + (self.$class()) + " ")};
      result = $rb_plus(result, ($a = ($b = self.$each_pair()).$map, $a.$$p = (TMP_12 = function(name, value){var self = TMP_12.$$s || this;
if (name == null) name = nil;if (value == null) value = nil;
      return "" + (name) + "=" + (value.$inspect())}, TMP_12.$$s = self, TMP_12), $a).call($b).$join(", "));
      result = $rb_plus(result, ">");
      return result;
    };

    Opal.defn(self, '$to_s', def.$inspect);

    def.$to_h = function() {
      var $a, $b, TMP_13, self = this;

      return ($a = ($b = self.$members()).$inject, $a.$$p = (TMP_13 = function(h, name){var self = TMP_13.$$s || this;
if (h == null) h = nil;if (name == null) name = nil;
      h['$[]='](name, self['$[]'](name));
        return h;}, TMP_13.$$s = self, TMP_13), $a).call($b, $hash2([], {}));
    };

    return (def.$values_at = function(args) {
      var $a, $b, TMP_14, self = this;

      args = $slice.call(arguments, 0);
      args = ($a = ($b = args).$map, $a.$$p = (TMP_14 = function(arg){var self = TMP_14.$$s || this;
if (arg == null) arg = nil;
      return arg.$$is_range ? arg.$to_a() : arg;}, TMP_14.$$s = self, TMP_14), $a).call($b).$flatten();
      
      var result = [];
      for (var i = 0, len = args.length; i < len; i++) {
        if (!args[i].$$is_number) {
          self.$raise($scope.get('TypeError'), "no implicit conversion of " + ((args[i]).$class()) + " into Integer")
        }
        result.push(self['$[]'](args[i]));
      }
      return result;
    ;
    }, nil) && 'values_at';
  })(self, null);
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/io"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var $a, $b, self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $module = Opal.module, $gvars = Opal.gvars;
  if ($gvars.stdout == null) $gvars.stdout = nil;
  if ($gvars.stderr == null) $gvars.stderr = nil;

  Opal.add_stubs(['$attr_accessor', '$size', '$write', '$join', '$map', '$String', '$empty?', '$concat', '$chomp', '$getbyte', '$getc', '$raise', '$new', '$write_proc=', '$extend']);
  (function($base, $super) {
    function $IO(){};
    var self = $IO = $klass($base, $super, 'IO', $IO);

    var def = self.$$proto, $scope = self.$$scope;

    def.tty = def.closed = nil;
    Opal.cdecl($scope, 'SEEK_SET', 0);

    Opal.cdecl($scope, 'SEEK_CUR', 1);

    Opal.cdecl($scope, 'SEEK_END', 2);

    def['$tty?'] = function() {
      var self = this;

      return self.tty;
    };

    def['$closed?'] = function() {
      var self = this;

      return self.closed;
    };

    self.$attr_accessor("write_proc");

    def.$write = function(string) {
      var self = this;

      self.write_proc(string);
      return string.$size();
    };

    self.$attr_accessor("sync");

    (function($base) {
      var self = $module($base, 'Writable');

      var def = self.$$proto, $scope = self.$$scope;

      Opal.defn(self, '$<<', function(string) {
        var self = this;

        self.$write(string);
        return self;
      });

      Opal.defn(self, '$print', function(args) {
        var $a, $b, TMP_1, self = this;
        if ($gvars[","] == null) $gvars[","] = nil;

        args = $slice.call(arguments, 0);
        self.$write(($a = ($b = args).$map, $a.$$p = (TMP_1 = function(arg){var self = TMP_1.$$s || this;
if (arg == null) arg = nil;
        return self.$String(arg)}, TMP_1.$$s = self, TMP_1), $a).call($b).$join($gvars[","]));
        return nil;
      });

      Opal.defn(self, '$puts', function(args) {
        var $a, $b, TMP_2, self = this, newline = nil;
        if ($gvars["/"] == null) $gvars["/"] = nil;

        args = $slice.call(arguments, 0);
        newline = $gvars["/"];
        if ((($a = args['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$write($gvars["/"])
          } else {
          self.$write(($a = ($b = args).$map, $a.$$p = (TMP_2 = function(arg){var self = TMP_2.$$s || this;
if (arg == null) arg = nil;
          return self.$String(arg).$chomp()}, TMP_2.$$s = self, TMP_2), $a).call($b).$concat([nil]).$join(newline))
        };
        return nil;
      });
    })(self);

    return (function($base) {
      var self = $module($base, 'Readable');

      var def = self.$$proto, $scope = self.$$scope;

      Opal.defn(self, '$readbyte', function() {
        var self = this;

        return self.$getbyte();
      });

      Opal.defn(self, '$readchar', function() {
        var self = this;

        return self.$getc();
      });

      Opal.defn(self, '$readline', function(sep) {
        var self = this;
        if ($gvars["/"] == null) $gvars["/"] = nil;

        if (sep == null) {
          sep = $gvars["/"]
        }
        return self.$raise($scope.get('NotImplementedError'));
      });

      Opal.defn(self, '$readpartial', function(integer, outbuf) {
        var self = this;

        if (outbuf == null) {
          outbuf = nil
        }
        return self.$raise($scope.get('NotImplementedError'));
      });
    })(self);
  })(self, null);
  Opal.cdecl($scope, 'STDERR', $gvars.stderr = $scope.get('IO').$new());
  Opal.cdecl($scope, 'STDIN', $gvars.stdin = $scope.get('IO').$new());
  Opal.cdecl($scope, 'STDOUT', $gvars.stdout = $scope.get('IO').$new());
  (($a = [typeof(process) === 'object' ? function(s){process.stdout.write(s)} : function(s){console.log(s)}]), $b = $gvars.stdout, $b['$write_proc='].apply($b, $a), $a[$a.length-1]);
  (($a = [typeof(process) === 'object' ? function(s){process.stderr.write(s)} : function(s){console.warn(s)}]), $b = $gvars.stderr, $b['$write_proc='].apply($b, $a), $a[$a.length-1]);
  $gvars.stdout.$extend((($scope.get('IO')).$$scope.get('Writable')));
  return $gvars.stderr.$extend((($scope.get('IO')).$$scope.get('Writable')));
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/main"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$include']);
  Opal.defs(self, '$to_s', function() {
    var self = this;

    return "main";
  });
  return (Opal.defs(self, '$include', function(mod) {
    var self = this;

    return $scope.get('Object').$include(mod);
  }), nil) && 'include';
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/variables"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $gvars = Opal.gvars, $hash2 = Opal.hash2;

  Opal.add_stubs(['$new']);
  $gvars["&"] = $gvars["~"] = $gvars["`"] = $gvars["'"] = nil;
  $gvars.LOADED_FEATURES = $gvars["\""] = Opal.loaded_features;
  $gvars.LOAD_PATH = $gvars[":"] = [];
  $gvars["/"] = "\n";
  $gvars[","] = nil;
  Opal.cdecl($scope, 'ARGV', []);
  Opal.cdecl($scope, 'ARGF', $scope.get('Object').$new());
  Opal.cdecl($scope, 'ENV', $hash2([], {}));
  $gvars.VERBOSE = false;
  $gvars.DEBUG = false;
  $gvars.SAFE = 0;
  Opal.cdecl($scope, 'RUBY_PLATFORM', "opal");
  Opal.cdecl($scope, 'RUBY_ENGINE', "opal");
  Opal.cdecl($scope, 'RUBY_VERSION', "2.1.5");
  Opal.cdecl($scope, 'RUBY_ENGINE_VERSION', "0.8.0");
  return Opal.cdecl($scope, 'RUBY_RELEASE_DATE', "2015-07-16");
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/dir"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$[]']);
  return (function($base, $super) {
    function $Dir(){};
    var self = $Dir = $klass($base, $super, 'Dir', $Dir);

    var def = self.$$proto, $scope = self.$$scope;

    return (function(self) {
      var $scope = self.$$scope, def = self.$$proto, TMP_1;

      self.$$proto.$chdir = TMP_1 = function(dir) {
        var $a, self = this, $iter = TMP_1.$$p, $yield = $iter || nil, prev_cwd = nil;

        TMP_1.$$p = null;
        try {
        prev_cwd = Opal.current_dir;
        Opal.current_dir = dir;
        return $a = Opal.yieldX($yield, []), $a === $breaker ? $a : $a;
        } finally {
        Opal.current_dir = prev_cwd;
        };
      };
      self.$$proto.$pwd = function() {
        var self = this;

        return Opal.current_dir || '.';
      };
      self.$$proto.$getwd = self.$$proto.$pwd;
      return (self.$$proto.$home = function() {
        var $a, self = this;

        return ((($a = $scope.get('ENV')['$[]']("HOME")) !== false && $a !== nil) ? $a : ".");
      }, nil) && 'home';
    })(self.$singleton_class())
  })(self, null)
};

/* Generated by Opal 0.8.0 */
Opal.modules["corelib/file"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $range = Opal.range;

  Opal.add_stubs(['$join', '$compact', '$split', '$==', '$first', '$[]=', '$home', '$each', '$pop', '$<<', '$[]', '$gsub', '$find', '$=~']);
  return (function($base, $super) {
    function $File(){};
    var self = $File = $klass($base, $super, 'File', $File);

    var def = self.$$proto, $scope = self.$$scope;

    Opal.cdecl($scope, 'Separator', Opal.cdecl($scope, 'SEPARATOR', "/"));

    Opal.cdecl($scope, 'ALT_SEPARATOR', nil);

    Opal.cdecl($scope, 'PATH_SEPARATOR', ":");

    return (function(self) {
      var $scope = self.$$scope, def = self.$$proto;

      self.$$proto.$expand_path = function(path, basedir) {
        var $a, $b, TMP_1, self = this, parts = nil, new_parts = nil;

        if (basedir == null) {
          basedir = nil
        }
        path = [basedir, path].$compact().$join($scope.get('SEPARATOR'));
        parts = path.$split($scope.get('SEPARATOR'));
        new_parts = [];
        if (parts.$first()['$==']("~")) {
          parts['$[]='](0, $scope.get('Dir').$home())};
        ($a = ($b = parts).$each, $a.$$p = (TMP_1 = function(part){var self = TMP_1.$$s || this;
if (part == null) part = nil;
        if (part['$==']("..")) {
            return new_parts.$pop()
            } else {
            return new_parts['$<<'](part)
          }}, TMP_1.$$s = self, TMP_1), $a).call($b);
        return new_parts.$join($scope.get('SEPARATOR'));
      };
      self.$$proto.$dirname = function(path) {
        var self = this;

        return self.$split(path)['$[]']($range(0, -2, false));
      };
      self.$$proto.$basename = function(path) {
        var self = this;

        return self.$split(path)['$[]'](-1);
      };
      self.$$proto['$exist?'] = function(path) {
        var self = this;

        return Opal.modules[path] != null;
      };
      self.$$proto['$exists?'] = self.$$proto['$exist?'];
      self.$$proto['$directory?'] = function(path) {
        var $a, $b, TMP_2, self = this, files = nil, file = nil;

        files = [];
        
        for (var key in Opal.modules) {
          files.push(key)
        }
      ;
        path = path.$gsub((new RegExp("(^." + $scope.get('SEPARATOR') + "+|" + $scope.get('SEPARATOR') + "+$)")));
        file = ($a = ($b = files).$find, $a.$$p = (TMP_2 = function(file){var self = TMP_2.$$s || this;
if (file == null) file = nil;
        return file['$=~']((new RegExp("^" + path)))}, TMP_2.$$s = self, TMP_2), $a).call($b);
        return file;
      };
      self.$$proto.$join = function(paths) {
        var self = this;

        paths = $slice.call(arguments, 0);
        return paths.$join($scope.get('SEPARATOR')).$gsub((new RegExp("" + $scope.get('SEPARATOR') + "+")), $scope.get('SEPARATOR'));
      };
      return (self.$$proto.$split = function(path) {
        var self = this;

        return path.$split($scope.get('SEPARATOR'));
      }, nil) && 'split';
    })(self.$singleton_class());
  })(self, $scope.get('IO'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$require']);
  self.$require("corelib/runtime");
  self.$require("corelib/helpers");
  self.$require("corelib/module");
  self.$require("corelib/class");
  self.$require("corelib/basic_object");
  self.$require("corelib/kernel");
  self.$require("corelib/nil_class");
  self.$require("corelib/boolean");
  self.$require("corelib/error");
  self.$require("corelib/regexp");
  self.$require("corelib/comparable");
  self.$require("corelib/enumerable");
  self.$require("corelib/enumerator");
  self.$require("corelib/array");
  self.$require("corelib/array/inheritance");
  self.$require("corelib/hash");
  self.$require("corelib/string");
  self.$require("corelib/string/inheritance");
  self.$require("corelib/match_data");
  self.$require("corelib/numeric");
  self.$require("corelib/complex");
  self.$require("corelib/rational");
  self.$require("corelib/proc");
  self.$require("corelib/method");
  self.$require("corelib/range");
  self.$require("corelib/time");
  self.$require("corelib/struct");
  self.$require("corelib/io");
  self.$require("corelib/main");
  self.$require("corelib/variables");
  self.$require("corelib/dir");
  return self.$require("corelib/file");
};

/* Generated by Opal 0.8.0 */
Opal.modules["native"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  function $rb_ge(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs >= rhs : lhs['$>='](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $range = Opal.range, $hash2 = Opal.hash2, $klass = Opal.klass, $gvars = Opal.gvars;

  Opal.add_stubs(['$try_convert', '$native?', '$respond_to?', '$to_n', '$raise', '$inspect', '$Native', '$end_with?', '$define_method', '$[]', '$convert', '$call', '$to_proc', '$new', '$each', '$native_reader', '$native_writer', '$extend', '$alias_method', '$to_a', '$_Array', '$include', '$method_missing', '$bind', '$instance_method', '$[]=', '$slice', '$length', '$enum_for', '$===', '$<<', '$==', '$instance_variable_set', '$members', '$each_with_index', '$each_pair', '$name', '$native_module']);
  (function($base) {
    var self = $module($base, 'Native');

    var def = self.$$proto, $scope = self.$$scope, TMP_1;

    Opal.defs(self, '$is_a?', function(object, klass) {
      var self = this;

      
      try {
        return object instanceof self.$try_convert(klass);
      }
      catch (e) {
        return false;
      }
    ;
    });

    Opal.defs(self, '$try_convert', function(value) {
      var self = this;

      
      if (self['$native?'](value)) {
        return value;
      }
      else if (value['$respond_to?']("to_n")) {
        return value.$to_n();
      }
      else {
        return nil;
      }
    ;
    });

    Opal.defs(self, '$convert', function(value) {
      var self = this;

      
      if (self['$native?'](value)) {
        return value;
      }
      else if (value['$respond_to?']("to_n")) {
        return value.$to_n();
      }
      else {
        self.$raise($scope.get('ArgumentError'), "" + (value.$inspect()) + " isn't native");
      }
    ;
    });

    Opal.defs(self, '$call', TMP_1 = function(obj, key, args) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      args = $slice.call(arguments, 2);
      TMP_1.$$p = null;
      
      var prop = obj[key];

      if (prop instanceof Function) {
        var converted = new Array(args.length);

        for (var i = 0, length = args.length; i < length; i++) {
          var item = args[i],
              conv = self.$try_convert(item);

          converted[i] = conv === nil ? item : conv;
        }

        if (block !== nil) {
          converted.push(block);
        }

        return self.$Native(prop.apply(obj, converted));
      }
      else {
        return self.$Native(prop);
      }
    ;
    });

    (function($base) {
      var self = $module($base, 'Helpers');

      var def = self.$$proto, $scope = self.$$scope;

      Opal.defn(self, '$alias_native', function(new$, old, options) {
        var $a, $b, TMP_2, $c, TMP_3, $d, TMP_4, self = this, as = nil;

        if (old == null) {
          old = new$
        }
        if (options == null) {
          options = $hash2([], {})
        }
        if ((($a = old['$end_with?']("=")) !== nil && (!$a.$$is_boolean || $a == true))) {
          return ($a = ($b = self).$define_method, $a.$$p = (TMP_2 = function(value){var self = TMP_2.$$s || this;
            if (self["native"] == null) self["native"] = nil;
if (value == null) value = nil;
          self["native"][old['$[]']($range(0, -2, false))] = $scope.get('Native').$convert(value);
            return value;}, TMP_2.$$s = self, TMP_2), $a).call($b, new$)
        } else if ((($a = as = options['$[]']("as")) !== nil && (!$a.$$is_boolean || $a == true))) {
          return ($a = ($c = self).$define_method, $a.$$p = (TMP_3 = function(args){var self = TMP_3.$$s || this, block, $a, $b, $c, value = nil;
            if (self["native"] == null) self["native"] = nil;
args = $slice.call(arguments, 0);
            block = TMP_3.$$p || nil, TMP_3.$$p = null;
          if ((($a = value = ($b = ($c = $scope.get('Native')).$call, $b.$$p = block.$to_proc(), $b).apply($c, [self["native"], old].concat(args))) !== nil && (!$a.$$is_boolean || $a == true))) {
              return as.$new(value.$to_n())
              } else {
              return nil
            }}, TMP_3.$$s = self, TMP_3), $a).call($c, new$)
          } else {
          return ($a = ($d = self).$define_method, $a.$$p = (TMP_4 = function(args){var self = TMP_4.$$s || this, block, $a, $b;
            if (self["native"] == null) self["native"] = nil;
args = $slice.call(arguments, 0);
            block = TMP_4.$$p || nil, TMP_4.$$p = null;
          return ($a = ($b = $scope.get('Native')).$call, $a.$$p = block.$to_proc(), $a).apply($b, [self["native"], old].concat(args))}, TMP_4.$$s = self, TMP_4), $a).call($d, new$)
        };
      });

      Opal.defn(self, '$native_reader', function(names) {
        var $a, $b, TMP_5, self = this;

        names = $slice.call(arguments, 0);
        return ($a = ($b = names).$each, $a.$$p = (TMP_5 = function(name){var self = TMP_5.$$s || this, $a, $b, TMP_6;
if (name == null) name = nil;
        return ($a = ($b = self).$define_method, $a.$$p = (TMP_6 = function(){var self = TMP_6.$$s || this;
            if (self["native"] == null) self["native"] = nil;

          return self.$Native(self["native"][name])}, TMP_6.$$s = self, TMP_6), $a).call($b, name)}, TMP_5.$$s = self, TMP_5), $a).call($b);
      });

      Opal.defn(self, '$native_writer', function(names) {
        var $a, $b, TMP_7, self = this;

        names = $slice.call(arguments, 0);
        return ($a = ($b = names).$each, $a.$$p = (TMP_7 = function(name){var self = TMP_7.$$s || this, $a, $b, TMP_8;
if (name == null) name = nil;
        return ($a = ($b = self).$define_method, $a.$$p = (TMP_8 = function(value){var self = TMP_8.$$s || this;
            if (self["native"] == null) self["native"] = nil;
if (value == null) value = nil;
          return self.$Native(self["native"][name] = value)}, TMP_8.$$s = self, TMP_8), $a).call($b, "" + (name) + "=")}, TMP_7.$$s = self, TMP_7), $a).call($b);
      });

      Opal.defn(self, '$native_accessor', function(names) {
        var $a, $b, self = this;

        names = $slice.call(arguments, 0);
        ($a = self).$native_reader.apply($a, [].concat(names));
        return ($b = self).$native_writer.apply($b, [].concat(names));
      });
    })(self);

    Opal.defs(self, '$included', function(klass) {
      var self = this;

      return klass.$extend($scope.get('Helpers'));
    });

    Opal.defn(self, '$initialize', function(native$) {
      var $a, self = this;

      if ((($a = $scope.get('Kernel')['$native?'](native$)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        $scope.get('Kernel').$raise($scope.get('ArgumentError'), "" + (native$.$inspect()) + " isn't native")
      };
      return self["native"] = native$;
    });

    Opal.defn(self, '$to_n', function() {
      var self = this;
      if (self["native"] == null) self["native"] = nil;

      return self["native"];
    });
  })(self);
  (function($base) {
    var self = $module($base, 'Kernel');

    var def = self.$$proto, $scope = self.$$scope, TMP_9;

    Opal.defn(self, '$native?', function(value) {
      var self = this;

      return value == null || !value.$$class;
    });

    Opal.defn(self, '$Native', function(obj) {
      var $a, self = this;

      if ((($a = obj == null) !== nil && (!$a.$$is_boolean || $a == true))) {
        return nil
      } else if ((($a = self['$native?'](obj)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return (($scope.get('Native')).$$scope.get('Object')).$new(obj)
        } else {
        return obj
      };
    });

    self.$alias_method("_Array", "Array");

    Opal.defn(self, '$Array', TMP_9 = function(object, args) {
      var $a, $b, self = this, $iter = TMP_9.$$p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_9.$$p = null;
      if ((($a = self['$native?'](object)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return ($a = ($b = (($scope.get('Native')).$$scope.get('Array'))).$new, $a.$$p = block.$to_proc(), $a).apply($b, [object].concat(args)).$to_a()};
      return self.$_Array(object);
    });
  })(self);
  (function($base, $super) {
    function $Object(){};
    var self = $Object = $klass($base, $super, 'Object', $Object);

    var def = self.$$proto, $scope = self.$$scope, TMP_10, TMP_11, TMP_12;

    def["native"] = nil;
    self.$include(Opal.get('Native'));

    Opal.defn(self, '$==', function(other) {
      var self = this;

      return self["native"] === $scope.get('Native').$try_convert(other);
    });

    Opal.defn(self, '$has_key?', function(name) {
      var self = this;

      return Opal.hasOwnProperty.call(self["native"], name);
    });

    Opal.defn(self, '$key?', def['$has_key?']);

    Opal.defn(self, '$include?', def['$has_key?']);

    Opal.defn(self, '$member?', def['$has_key?']);

    Opal.defn(self, '$each', TMP_10 = function(args) {
      var $a, self = this, $iter = TMP_10.$$p, $yield = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_10.$$p = null;
      if (($yield !== nil)) {
        
        for (var key in self["native"]) {
          ((($a = Opal.yieldX($yield, [key, self["native"][key]])) === $breaker) ? $breaker.$v : $a)
        }
      ;
        return self;
        } else {
        return ($a = self).$method_missing.apply($a, ["each"].concat(args))
      };
    });

    Opal.defn(self, '$[]', function(key) {
      var self = this;

      
      var prop = self["native"][key];

      if (prop instanceof Function) {
        return prop;
      }
      else {
        return Opal.get('Native').$call(self["native"], key)
      }
    ;
    });

    Opal.defn(self, '$[]=', function(key, value) {
      var $a, self = this, native$ = nil;

      native$ = $scope.get('Native').$try_convert(value);
      if ((($a = native$ === nil) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self["native"][key] = value;
        } else {
        return self["native"][key] = native$;
      };
    });

    Opal.defn(self, '$merge!', function(other) {
      var self = this;

      
      var other = $scope.get('Native').$convert(other);

      for (var prop in other) {
        self["native"][prop] = other[prop];
      }
    ;
      return self;
    });

    Opal.defn(self, '$respond_to?', function(name, include_all) {
      var self = this;

      if (include_all == null) {
        include_all = false
      }
      return $scope.get('Kernel').$instance_method("respond_to?").$bind(self).$call(name, include_all);
    });

    Opal.defn(self, '$respond_to_missing?', function(name) {
      var self = this;

      return Opal.hasOwnProperty.call(self["native"], name);
    });

    Opal.defn(self, '$method_missing', TMP_11 = function(mid, args) {
      var $a, $b, self = this, $iter = TMP_11.$$p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_11.$$p = null;
      
      if (mid.charAt(mid.length - 1) === '=') {
        return self['$[]='](mid.$slice(0, $rb_minus(mid.$length(), 1)), args['$[]'](0));
      }
      else {
        return ($a = ($b = Opal.get('Native')).$call, $a.$$p = block.$to_proc(), $a).apply($b, [self["native"], mid].concat(args));
      }
    ;
    });

    Opal.defn(self, '$nil?', function() {
      var self = this;

      return false;
    });

    Opal.defn(self, '$is_a?', function(klass) {
      var self = this;

      return Opal.is_a(self, klass);
    });

    Opal.defn(self, '$kind_of?', def['$is_a?']);

    Opal.defn(self, '$instance_of?', function(klass) {
      var self = this;

      return self.$$class === klass;
    });

    Opal.defn(self, '$class', function() {
      var self = this;

      return self.$$class;
    });

    Opal.defn(self, '$to_a', TMP_12 = function(options) {
      var $a, $b, self = this, $iter = TMP_12.$$p, block = $iter || nil;

      if (options == null) {
        options = $hash2([], {})
      }
      TMP_12.$$p = null;
      return ($a = ($b = (($scope.get('Native')).$$scope.get('Array'))).$new, $a.$$p = block.$to_proc(), $a).call($b, self["native"], options).$to_a();
    });

    return (Opal.defn(self, '$inspect', function() {
      var self = this;

      return "#<Native:" + (String(self["native"])) + ">";
    }), nil) && 'inspect';
  })($scope.get('Native'), $scope.get('BasicObject'));
  (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self.$$proto, $scope = self.$$scope, TMP_13, TMP_14;

    def.named = def["native"] = def.get = def.block = def.set = def.length = nil;
    self.$include($scope.get('Native'));

    self.$include($scope.get('Enumerable'));

    def.$initialize = TMP_13 = function(native$, options) {
      var $a, self = this, $iter = TMP_13.$$p, block = $iter || nil;

      if (options == null) {
        options = $hash2([], {})
      }
      TMP_13.$$p = null;
      Opal.find_super_dispatcher(self, 'initialize', TMP_13, null).apply(self, [native$]);
      self.get = ((($a = options['$[]']("get")) !== false && $a !== nil) ? $a : options['$[]']("access"));
      self.named = options['$[]']("named");
      self.set = ((($a = options['$[]']("set")) !== false && $a !== nil) ? $a : options['$[]']("access"));
      self.length = ((($a = options['$[]']("length")) !== false && $a !== nil) ? $a : "length");
      self.block = block;
      if ((($a = self.$length() == null) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.$raise($scope.get('ArgumentError'), "no length found on the array-like object")
        } else {
        return nil
      };
    };

    def.$each = TMP_14 = function() {
      var self = this, $iter = TMP_14.$$p, block = $iter || nil;

      TMP_14.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each")
      };
      
      for (var i = 0, length = self.$length(); i < length; i++) {
        var value = Opal.yield1(block, self['$[]'](i));

        if (value === $breaker) {
          return $breaker.$v;
        }
      }
    ;
      return self;
    };

    def['$[]'] = function(index) {
      var $a, self = this, result = nil, $case = nil;

      result = (function() {$case = index;if ($scope.get('String')['$===']($case) || $scope.get('Symbol')['$===']($case)) {if ((($a = self.named) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self["native"][self.named](index);
        } else {
        return self["native"][index];
      }}else if ($scope.get('Integer')['$===']($case)) {if ((($a = self.get) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self["native"][self.get](index);
        } else {
        return self["native"][index];
      }}else { return nil }})();
      if (result !== false && result !== nil) {
        if ((($a = self.block) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self.block.$call(result)
          } else {
          return self.$Native(result)
        }
        } else {
        return nil
      };
    };

    def['$[]='] = function(index, value) {
      var $a, self = this;

      if ((($a = self.set) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self["native"][self.set](index, $scope.get('Native').$convert(value));
        } else {
        return self["native"][index] = $scope.get('Native').$convert(value);
      };
    };

    def.$last = function(count) {
      var $a, self = this, index = nil, result = nil;

      if (count == null) {
        count = nil
      }
      if (count !== false && count !== nil) {
        index = $rb_minus(self.$length(), 1);
        result = [];
        while ($rb_ge(index, 0)) {
        result['$<<'](self['$[]'](index));
        index = $rb_minus(index, 1);};
        return result;
        } else {
        return self['$[]']($rb_minus(self.$length(), 1))
      };
    };

    def.$length = function() {
      var self = this;

      return self["native"][self.length];
    };

    Opal.defn(self, '$to_ary', def.$to_a);

    return (def.$inspect = function() {
      var self = this;

      return self.$to_a().$inspect();
    }, nil) && 'inspect';
  })($scope.get('Native'), null);
  (function($base, $super) {
    function $Numeric(){};
    var self = $Numeric = $klass($base, $super, 'Numeric', $Numeric);

    var def = self.$$proto, $scope = self.$$scope;

    return (def.$to_n = function() {
      var self = this;

      return self.valueOf();
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Proc(){};
    var self = $Proc = $klass($base, $super, 'Proc', $Proc);

    var def = self.$$proto, $scope = self.$$scope;

    return (def.$to_n = function() {
      var self = this;

      return self;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self.$$proto, $scope = self.$$scope;

    return (def.$to_n = function() {
      var self = this;

      return self.valueOf();
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Regexp(){};
    var self = $Regexp = $klass($base, $super, 'Regexp', $Regexp);

    var def = self.$$proto, $scope = self.$$scope;

    return (def.$to_n = function() {
      var self = this;

      return self.valueOf();
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $MatchData(){};
    var self = $MatchData = $klass($base, $super, 'MatchData', $MatchData);

    var def = self.$$proto, $scope = self.$$scope;

    def.matches = nil;
    return (def.$to_n = function() {
      var self = this;

      return self.matches;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Struct(){};
    var self = $Struct = $klass($base, $super, 'Struct', $Struct);

    var def = self.$$proto, $scope = self.$$scope;

    def.$initialize = function(args) {
      var $a, $b, TMP_15, $c, TMP_16, self = this, object = nil;

      args = $slice.call(arguments, 0);
      if ((($a = (($b = args.$length()['$=='](1)) ? self['$native?'](args['$[]'](0)) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        object = args['$[]'](0);
        return ($a = ($b = self.$members()).$each, $a.$$p = (TMP_15 = function(name){var self = TMP_15.$$s || this;
if (name == null) name = nil;
        return self.$instance_variable_set("@" + (name), self.$Native(object[name]))}, TMP_15.$$s = self, TMP_15), $a).call($b);
        } else {
        return ($a = ($c = self.$members()).$each_with_index, $a.$$p = (TMP_16 = function(name, index){var self = TMP_16.$$s || this;
if (name == null) name = nil;if (index == null) index = nil;
        return self.$instance_variable_set("@" + (name), args['$[]'](index))}, TMP_16.$$s = self, TMP_16), $a).call($c)
      };
    };

    return (def.$to_n = function() {
      var $a, $b, TMP_17, self = this, result = nil;

      result = {};
      ($a = ($b = self).$each_pair, $a.$$p = (TMP_17 = function(name, value){var self = TMP_17.$$s || this;
if (name == null) name = nil;if (value == null) value = nil;
      return result[name] = value.$to_n();}, TMP_17.$$s = self, TMP_17), $a).call($b);
      return result;
    }, nil) && 'to_n';
  })(self, null);
  (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self.$$proto, $scope = self.$$scope;

    return (def.$to_n = function() {
      var self = this;

      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var obj = self[i];

        if ((obj)['$respond_to?']("to_n")) {
          result.push((obj).$to_n());
        }
        else {
          result.push(obj);
        }
      }

      return result;
    ;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Boolean(){};
    var self = $Boolean = $klass($base, $super, 'Boolean', $Boolean);

    var def = self.$$proto, $scope = self.$$scope;

    return (def.$to_n = function() {
      var self = this;

      return self.valueOf();
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Time(){};
    var self = $Time = $klass($base, $super, 'Time', $Time);

    var def = self.$$proto, $scope = self.$$scope;

    return (def.$to_n = function() {
      var self = this;

      return self;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $NilClass(){};
    var self = $NilClass = $klass($base, $super, 'NilClass', $NilClass);

    var def = self.$$proto, $scope = self.$$scope;

    return (def.$to_n = function() {
      var self = this;

      return null;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Hash(){};
    var self = $Hash = $klass($base, $super, 'Hash', $Hash);

    var def = self.$$proto, $scope = self.$$scope, TMP_18;

    def.$initialize = TMP_18 = function(defaults) {
      var self = this, $iter = TMP_18.$$p, block = $iter || nil;

      TMP_18.$$p = null;
      
      if (defaults != null) {
        if (defaults.constructor === Object) {
          var _map = self.map,
              smap = self.smap,
              keys = self.keys,
              map, khash, value;

          for (var key in defaults) {
            value = defaults[key];

            if (key.$$is_string) {
              map = smap;
              khash = key;
            } else {
              map = _map;
              khash = key.$hash();
            }

            if (value && value.constructor === Object) {
              map[khash] = $scope.get('Hash').$new(value);
            }
            else {
              map[khash] = self.$Native(value);
            }

            keys.push(key);
          }
        }
        else {
          self.none = defaults;
        }
      }
      else if (block !== nil) {
        self.proc = block;
      }

      return self;
    
    };

    return (def.$to_n = function() {
      var self = this;

      
      var result = {},
          keys   = self.keys,
          _map   = self.map,
          smap   = self.smap,
          map, khash, value, key;

      for (var i = 0, length = keys.length; i < length; i++) {
        key   = keys[i];

        if (key.$$is_string) {
          map = smap;
          khash = key;
        } else {
          map = _map;
          khash = key.$hash();
        }

        value = map[khash];

        if ((value)['$respond_to?']("to_n")) {
          result[key] = (value).$to_n();
        }
        else {
          result[key] = value;
        }
      }

      return result;
    ;
    }, nil) && 'to_n';
  })(self, null);
  (function($base, $super) {
    function $Module(){};
    var self = $Module = $klass($base, $super, 'Module', $Module);

    var def = self.$$proto, $scope = self.$$scope;

    return (def.$native_module = function() {
      var self = this;

      return Opal.global[self.$name()] = self;
    }, nil) && 'native_module'
  })(self, null);
  (function($base, $super) {
    function $Class(){};
    var self = $Class = $klass($base, $super, 'Class', $Class);

    var def = self.$$proto, $scope = self.$$scope;

    def.$native_alias = function(new_jsid, existing_mid) {
      var self = this;

      
      var aliased = self.$$proto['$' + existing_mid];
      if (!aliased) {
        self.$raise($scope.get('NameError'), "undefined method `" + (existing_mid) + "' for class `" + (self.$inspect()) + "'");
      }
      self.$$proto[new_jsid] = aliased;
    ;
    };

    return (def.$native_class = function() {
      var self = this;

      self.$native_module();
      self["new"] = self.$new;
    }, nil) && 'native_class';
  })(self, null);
  return $gvars.$ = $gvars.global = self.$Native(Opal.global);
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/core/math/point"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$include', '$native?', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'PIXI');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Point(){};
      var self = $Point = $klass($base, $super, 'Point', $Point);

      var def = self.$$proto, $scope = self.$$scope, TMP_1;

      self.$include($scope.get('Native'));

      Opal.defs(self, '$new', TMP_1 = function(x_or_native, y) {
        var $a, self = this, $iter = TMP_1.$$p, $yield = $iter || nil;

        TMP_1.$$p = null;
        if ((($a = self['$native?'](x_or_native)) !== nil && (!$a.$$is_boolean || $a == true))) {
          return Opal.find_super_dispatcher(self, 'new', TMP_1, null, $Point).apply(self, [x_or_native])
          } else {
          return Opal.find_super_dispatcher(self, 'new', TMP_1, null, $Point).apply(self, [new PIXI.Point(x_or_native, y)])
        };
      });

      self.$alias_native("x");

      self.$alias_native("x=");

      self.$alias_native("y");

      self.$alias_native("y=");

      self.$alias_native("clone");

      self.$alias_native("copy");

      self.$alias_native("equals");

      return self.$alias_native("set");
    })(self, null)
  })(self)
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/core/display/display_object"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $hash2 = Opal.hash2;

  Opal.add_stubs(['$require', '$include', '$alias_native']);
  self.$require("opal/pixi/core/math/point");
  return (function($base) {
    var self = $module($base, 'PIXI');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base) {
      var self = $module($base, 'DisplayObject');

      var def = self.$$proto, $scope = self.$$scope;

      self.$include($scope.get('Native'));

      self.$alias_native("x");

      self.$alias_native("x=");

      self.$alias_native("y");

      self.$alias_native("y=");

      self.$alias_native("position", "position", $hash2(["as"], {"as": $scope.get('Point')}));

      self.$alias_native("position=");

      self.$alias_native("scale", "scale", $hash2(["as"], {"as": $scope.get('Point')}));

      self.$alias_native("scale=");

      self.$alias_native("pivot", "pivot", $hash2(["as"], {"as": $scope.get('Point')}));

      self.$alias_native("pivot=");

      self.$alias_native("rotation");

      self.$alias_native("rotation=");

      self.$alias_native("alpha");

      self.$alias_native("alpha=");

      self.$alias_native("visible");

      self.$alias_native("visible=");

      self.$alias_native("renderable");

      self.$alias_native("renderable=");

      self.$alias_native("parent");

      self.$alias_native("world_alpha", "worldAlpha");

      self.$alias_native("world_transform", "worldTransform");

      self.$alias_native("filter_area", "filterArea");

      self.$alias_native("filter_area=");

      self.$alias_native("world_visible", "worldVisible");

      self.$alias_native("mask");

      self.$alias_native("mask=");

      self.$alias_native("filters");

      self.$alias_native("filters=");

      self.$alias_native("destroy");
    })(self)
  })(self);
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/interaction/interactive_target"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module;

  Opal.add_stubs(['$require', '$include', '$alias_native']);
  self.$require("opal/pixi/core/math/point");
  return (function($base) {
    var self = $module($base, 'PIXI');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base) {
      var self = $module($base, 'InteractiveTarget');

      var def = self.$$proto, $scope = self.$$scope;

      self.$include($scope.get('Native'));

      self.$alias_native("interactive");

      self.$alias_native("interactive=");

      self.$alias_native("interactive_children", "interactiveChildren");

      self.$alias_native("interactive_children=", "interactiveChildren=");

      self.$alias_native("default_cursor", "defaultCursor");

      self.$alias_native("default_cursor=", "defaultCursor=");

      self.$alias_native("on");
    })(self)
  })(self);
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/core/display/container"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$alias_native']);
  self.$require("opal/pixi/core/display/display_object");
  self.$require("opal/pixi/interaction/interactive_target");
  return (function($base) {
    var self = $module($base, 'PIXI');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Container(){};
      var self = $Container = $klass($base, $super, 'Container', $Container);

      var def = self.$$proto, $scope = self.$$scope, TMP_1;

      self.$include($scope.get('Native'));

      self.$include((($scope.get('PIXI')).$$scope.get('DisplayObject')));

      self.$include((($scope.get('PIXI')).$$scope.get('InteractiveTarget')));

      def.$initialize = TMP_1 = function() {
        var self = this, $iter = TMP_1.$$p, $yield = $iter || nil;

        TMP_1.$$p = null;
        return Opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new PIXI.Container()]);
      };

      self.$alias_native("children");

      self.$alias_native("width");

      self.$alias_native("width=");

      self.$alias_native("height");

      self.$alias_native("height=");

      self.$alias_native("add_child", "addChild");

      self.$alias_native("add_child_at", "addChildAt");

      self.$alias_native("swap_children", "swapChildren");

      self.$alias_native("get_child_index", "getChildIndex");

      self.$alias_native("set_child_index", "setChildIndex");

      self.$alias_native("get_child_at", "getChildAt");

      self.$alias_native("remove_child", "removeChild");

      self.$alias_native("remove_child_at", "removeChildAt");

      self.$alias_native("remove_children", "removeChildren");

      self.$alias_native("generate_texture", "generateTexture");

      self.$alias_native("get_bounds", "getBounds");

      self.$alias_native("get_local_bounds", "getLocalBounds");

      self.$alias_native("render_webGL", "renderWebGL");

      self.$alias_native("render_canvas", "renderCanvas");

      return self.$alias_native("destroy");
    })(self, null)
  })(self);
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/core/renderers/webgl/filters/abstract_filter"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass, $hash2 = Opal.hash2;

  Opal.add_stubs(['$include', '$to_n', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'PIXI');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $AbstractFilter(){};
      var self = $AbstractFilter = $klass($base, $super, 'AbstractFilter', $AbstractFilter);

      var def = self.$$proto, $scope = self.$$scope, TMP_1;

      self.$include($scope.get('Native'));

      def.$initialize = TMP_1 = function(vertexSrc, fragmentSrc, uniforms) {
        var self = this, $iter = TMP_1.$$p, $yield = $iter || nil;

        if (uniforms == null) {
          uniforms = $hash2([], {})
        }
        TMP_1.$$p = null;
        return Opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new PIXI.AbstractFilter(vertexSrc, fragmentSrc, uniforms.$to_n())]);
      };

      self.$alias_native("padding");

      self.$alias_native("uniforms");

      self.$alias_native("get_shader", "getShader");

      self.$alias_native("apply_filter", "applyFilter");

      return self.$alias_native("sync_uniform", "syncUniform");
    })(self, null)
  })(self)
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/core/renderers/webgl/webgl_renderer"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass, $hash2 = Opal.hash2;

  Opal.add_stubs(['$include', '$native?', '$to_n', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'PIXI');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $WebGLRenderer(){};
      var self = $WebGLRenderer = $klass($base, $super, 'WebGLRenderer', $WebGLRenderer);

      var def = self.$$proto, $scope = self.$$scope, TMP_1;

      self.$include($scope.get('Native'));

      def.$initialize = TMP_1 = function(w_or_native, height, options) {
        var $a, self = this, $iter = TMP_1.$$p, $yield = $iter || nil;

        if (options == null) {
          options = $hash2([], {})
        }
        TMP_1.$$p = null;
        if ((($a = self['$native?'](w_or_native)) !== nil && (!$a.$$is_boolean || $a == true))) {
          return Opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [w_or_native])
          } else {
          return Opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new PIXI.WebGLRenderer(w_or_native, height, options.$to_n())])
        };
      };

      self.$alias_native("render");

      self.$alias_native("destroy");

      self.$alias_native("view");

      self.$alias_native("width");

      return self.$alias_native("height");
    })(self, null)
  })(self)
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/core/graphics/graphics"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$alias_native']);
  self.$require("opal/pixi/core/display/display_object");
  return (function($base) {
    var self = $module($base, 'PIXI');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Graphics(){};
      var self = $Graphics = $klass($base, $super, 'Graphics', $Graphics);

      var def = self.$$proto, $scope = self.$$scope, TMP_1;

      self.$include($scope.get('Native'));

      def.$initialize = TMP_1 = function() {
        var self = this, $iter = TMP_1.$$p, $yield = $iter || nil;

        TMP_1.$$p = null;
        return Opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new PIXI.Graphics()]);
      };

      self.$alias_native("fill_alpha", "fillAlpha");

      self.$alias_native("line_width", "lineWidth");

      self.$alias_native("line_color", "lineColor");

      self.$alias_native("tint");

      self.$alias_native("blend_mode", "blendMode");

      self.$alias_native("is_mask", "isMask");

      self.$alias_native("bounds_padding", "boundsPadding");

      self.$alias_native("clone");

      self.$alias_native("line_style", "lineStyle");

      self.$alias_native("move_to", "moveTo");

      self.$alias_native("line_to", "lineTo");

      self.$alias_native("quadratic_curve_to", "quadraticCurveTo");

      self.$alias_native("bezier_curve_to", "bezierCurveTo");

      self.$alias_native("arc_to", "arcTo");

      self.$alias_native("arc");

      self.$alias_native("begin_fill", "beginFill");

      self.$alias_native("end_fill", "endFill");

      self.$alias_native("draw_rect", "drawRect");

      self.$alias_native("draw_rounded_rect", "drawRoundedRect");

      self.$alias_native("draw_circle", "drawCircle");

      self.$alias_native("draw_ellipse", "drawEllipse");

      self.$alias_native("draw_polygon", "drawPolygon");

      self.$alias_native("clear");

      self.$alias_native("generate_texture", "generateTexture");

      self.$alias_native("get_bounds", "getBounds");

      self.$alias_native("contains_point", "containsPoint");

      self.$alias_native("update_local_bounds", "updateLocalBounds");

      self.$alias_native("draw_shape", "drawShape");

      return self.$alias_native("destroy");
    })(self, $scope.get('Container'))
  })(self);
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/core/textures/texture"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$include', '$new']);
  return (function($base) {
    var self = $module($base, 'PIXI');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Texture(){};
      var self = $Texture = $klass($base, $super, 'Texture', $Texture);

      var def = self.$$proto, $scope = self.$$scope;

      self.$include($scope.get('Native'));

      Opal.defs(self, '$from_image', function(name) {
        var self = this;

        return self.$new(PIXI.Texture.fromImage(name));
      });

      Opal.defs(self, '$from_frame', function(name) {
        var self = this;

        return self.$new(PIXI.Texture.fromFrame(name));
      });

      return (Opal.defs(self, '$from_video', function(name) {
        var self = this;

        return self.$new(PIXI.Texture.fromVideo(name));
      }), nil) && 'from_video';
    })(self, null)
  })(self)
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/core/sprites/sprite"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass, $hash2 = Opal.hash2;

  Opal.add_stubs(['$require', '$include', '$new', '$native?', '$to_n', '$alias_native']);
  self.$require("opal/pixi/core/display/container");
  self.$require("opal/pixi/core/math/point");
  self.$require("opal/pixi/core/textures/texture");
  self.$require("opal/pixi/interaction/interactive_target");
  return (function($base) {
    var self = $module($base, 'PIXI');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Sprite(){};
      var self = $Sprite = $klass($base, $super, 'Sprite', $Sprite);

      var def = self.$$proto, $scope = self.$$scope, TMP_1;

      self.$include($scope.get('Native'));

      self.$include((($scope.get('PIXI')).$$scope.get('DisplayObject')));

      self.$include((($scope.get('PIXI')).$$scope.get('InteractiveTarget')));

      Opal.defs(self, '$from_image', function(imageId, crossorigin, scaleMode) {
        var self = this;

        if (crossorigin == null) {
          crossorigin = false
        }
        if (scaleMode == null) {
          scaleMode = ""
        }
        return self.$new(PIXI.Sprite.fromImage(imageId, crossorigin, scaleMode));
      });

      Opal.defs(self, '$from_frame', function(frameId) {
        var self = this;

        return self.$new(PIXI.Sprite.fromFrame(frameId));
      });

      def.$initialize = TMP_1 = function(native_or_texture) {var $zuper = $slice.call(arguments, 0);
        var $a, self = this, $iter = TMP_1.$$p, $yield = $iter || nil;

        TMP_1.$$p = null;
        if ((($a = self['$native?'](native_or_texture)) !== nil && (!$a.$$is_boolean || $a == true))) {
          return Opal.find_super_dispatcher(self, 'initialize', TMP_1, $iter).apply(self, $zuper)
          } else {
          return Opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new PIXI.Sprite(native_or_texture.$to_n())])
        };
      };

      self.$alias_native("anchor", "anchor", $hash2(["as"], {"as": $scope.get('Point')}));

      self.$alias_native("anchor=");

      self.$alias_native("tint");

      self.$alias_native("tint=");

      self.$alias_native("blend_mode", "blendMode");

      self.$alias_native("blend_mode=");

      self.$alias_native("shader");

      self.$alias_native("shader=");

      self.$alias_native("cached_tint", "cachedTint");

      self.$alias_native("cached_tint=");

      self.$alias_native("texture", "texture", $hash2(["as"], {"as": $scope.get('Texture')}));

      self.$alias_native("texture=");

      self.$alias_native("width");

      self.$alias_native("width=");

      self.$alias_native("height");

      return self.$alias_native("height=");
    })(self, null)
  })(self);
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/core/text/text"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass, $hash2 = Opal.hash2;

  Opal.add_stubs(['$require', '$include', '$native?', '$to_n', '$alias_native']);
  self.$require("opal/pixi/core/sprites/sprite");
  return (function($base) {
    var self = $module($base, 'PIXI');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Text(){};
      var self = $Text = $klass($base, $super, 'Text', $Text);

      var def = self.$$proto, $scope = self.$$scope, TMP_1;

      self.$include($scope.get('Native'));

      def.$initialize = TMP_1 = function(text_or_native, style, resolution) {
        var $a, self = this, $iter = TMP_1.$$p, $yield = $iter || nil;

        if (style == null) {
          style = $hash2([], {})
        }
        if (resolution == null) {
          resolution = 1
        }
        TMP_1.$$p = null;
        if ((($a = self['$native?'](text_or_native)) !== nil && (!$a.$$is_boolean || $a == true))) {
          return Opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [text_or_native])
          } else {
          return Opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new PIXI.Text(text_or_native, style.$to_n(), resolution)])
        };
      };

      self.$alias_native("canvas");

      self.$alias_native("context");

      self.$alias_native("resolution");

      self.$alias_native("text");

      self.$alias_native("text=");

      self.$alias_native("style");

      self.$alias_native("style=");

      self.$alias_native("render_webGL", "renderWebGL");

      self.$alias_native("getBounds", "getBounds");

      return self.$alias_native("destroy");
    })(self, (($scope.get('PIXI')).$$scope.get('Sprite')))
  })(self);
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/core/textures/render_texture"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$include', '$native?', '$to_n', '$alias_native']);
  return (function($base) {
    var self = $module($base, 'PIXI');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $RenderTexture(){};
      var self = $RenderTexture = $klass($base, $super, 'RenderTexture', $RenderTexture);

      var def = self.$$proto, $scope = self.$$scope, TMP_1;

      self.$include($scope.get('Native'));

      def.$initialize = TMP_1 = function(native_or_renderer, width, height, scaleMode, resolution) {var $zuper = $slice.call(arguments, 0);
        var $a, self = this, $iter = TMP_1.$$p, $yield = $iter || nil;

        if (width == null) {
          width = 100
        }
        if (height == null) {
          height = 100
        }
        if (scaleMode == null) {
          scaleMode = CONST.SCALE_MODES.DEFAULT
        }
        if (resolution == null) {
          resolution = 1
        }
        TMP_1.$$p = null;
        if ((($a = self['$native?'](native_or_renderer)) !== nil && (!$a.$$is_boolean || $a == true))) {
          return Opal.find_super_dispatcher(self, 'initialize', TMP_1, $iter).apply(self, $zuper)
          } else {
          return Opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new PIXI.RenderTexture(native_or_renderer.$to_n(), width, height, scaleMode, resolution)])
        };
      };

      return self.$alias_native("render");
    })(self, null)
  })(self)
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/core/files"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$require']);
  self.$require("opal/pixi/core/display/container");
  self.$require("opal/pixi/core/display/display_object");
  self.$require("opal/pixi/core/renderers/webgl/filters/abstract_filter");
  self.$require("opal/pixi/core/renderers/webgl/webgl_renderer");
  self.$require("opal/pixi/core/graphics/graphics");
  self.$require("opal/pixi/core/sprites/sprite");
  self.$require("opal/pixi/core/text/text");
  self.$require("opal/pixi/core/textures/texture");
  return self.$require("opal/pixi/core/textures/render_texture");
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/extras/movie_clip"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$to_n', '$alias_native']);
  self.$require("opal/pixi/core/sprites/sprite");
  return (function($base) {
    var self = $module($base, 'Extras');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $MovieClip(){};
      var self = $MovieClip = $klass($base, $super, 'MovieClip', $MovieClip);

      var def = self.$$proto, $scope = self.$$scope, TMP_1;

      self.$include($scope.get('Native'));

      def.$initialize = TMP_1 = function(textures) {
        var self = this, $iter = TMP_1.$$p, $yield = $iter || nil;

        TMP_1.$$p = null;
        return Opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new PIXI.extras.MovieClip(textures.$to_n())]);
      };

      self.$alias_native("animation_speed", "animationSpeed");

      self.$alias_native("animation_speed=", "animationSpeed=");

      return self.$alias_native("play");
    })(self, (($scope.get('PIXI')).$$scope.get('Sprite')))
  })($scope.get('PIXI'));
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/extras/tiling_sprite"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass, $hash2 = Opal.hash2;

  Opal.add_stubs(['$require', '$include', '$to_n', '$alias_native']);
  self.$require("opal/pixi/core/sprites/sprite");
  self.$require("opal/pixi/core/math/point");
  return (function($base) {
    var self = $module($base, 'Extras');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $TilingSprite(){};
      var self = $TilingSprite = $klass($base, $super, 'TilingSprite', $TilingSprite);

      var def = self.$$proto, $scope = self.$$scope, TMP_1;

      self.$include($scope.get('Native'));

      def.$initialize = TMP_1 = function(texture, width, height) {
        var self = this, $iter = TMP_1.$$p, $yield = $iter || nil;

        TMP_1.$$p = null;
        return Opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new PIXI.extras.TilingSprite(texture.$to_n(),width,height)]);
      };

      self.$alias_native("tile_scale", "tileScale", $hash2(["as"], {"as": $scope.get('Point')}));

      self.$alias_native("tile_scale=", "tileScale=");

      self.$alias_native("tile_position", "tilePosition", $hash2(["as"], {"as": $scope.get('Point')}));

      return self.$alias_native("tile_position=", "tilePosition=");
    })(self, (($scope.get('PIXI')).$$scope.get('Sprite')))
  })($scope.get('PIXI'));
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/mesh/mesh"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include']);
  self.$require("opal/pixi/core/display/container");
  self.$require("opal/pixi/core/math/point");
  return (function($base) {
    var self = $module($base, 'Mesh');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Mesh(){};
      var self = $Mesh = $klass($base, $super, 'Mesh', $Mesh);

      var def = self.$$proto, $scope = self.$$scope;

      return self.$include($scope.get('Native'))
    })(self, (($scope.get('PIXI')).$$scope.get('Container')))
  })($scope.get('PIXI'));
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/mesh/rope"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$to_n', '$alias_native']);
  self.$require("opal/pixi/core/math/point");
  return (function($base) {
    var self = $module($base, 'Mesh');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Rope(){};
      var self = $Rope = $klass($base, $super, 'Rope', $Rope);

      var def = self.$$proto, $scope = self.$$scope, TMP_1;

      self.$include($scope.get('Native'));

      def.$initialize = TMP_1 = function(texture, points) {
        var self = this, $iter = TMP_1.$$p, $yield = $iter || nil;

        TMP_1.$$p = null;
        return Opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [new PIXI.mesh.Rope(texture.$to_n(), points.$to_n())]);
      };

      return self.$alias_native("position");
    })(self, (((($scope.get('PIXI')).$$scope.get('Mesh'))).$$scope.get('Mesh')))
  })($scope.get('PIXI'));
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi/setup"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$require']);
  self.$require("native");
  self.$require("opal/pixi/core/files");
  self.$require("opal/pixi/extras/movie_clip");
  self.$require("opal/pixi/extras/tiling_sprite");
  self.$require("opal/pixi/interaction/interactive_target");
  self.$require("opal/pixi/mesh/mesh");
  return self.$require("opal/pixi/mesh/rope");
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal/pixi"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$==', '$require']);
  if ($scope.get('RUBY_ENGINE')['$==']("opal")) {
    return self.$require("opal/pixi/setup")}
};

/* Generated by Opal 0.8.0 */
Opal.modules["opal-pixi"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$require']);
  return self.$require("opal/pixi")
};

/* Generated by Opal 0.8.0 */
Opal.modules["examples/basics/base"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$call']);
  return (function($base) {
    var self = $module($base, 'Examples');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Base(){};
      var self = $Base = $klass($base, $super, 'Base', $Base);

      var def = self.$$proto, $scope = self.$$scope;

      def.destroy = nil;
      return (def.$destroy = function() {
        var self = this;

        return self.destroy.$call();
      }, nil) && 'destroy'
    })(self, null)
  })($scope.get('PIXI'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["examples/basics/basic"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$new', '$from_image', '$x=', '$anchor', '$y=', '$position', '$scale=', '$add_child', '$rotation=', '$rotation', '$render', '$call']);
  return (function($base) {
    var self = $module($base, 'Examples');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Basic(){};
      var self = $Basic = $klass($base, $super, 'Basic', $Basic);

      var def = self.$$proto, $scope = self.$$scope;

      return (def.$initialize = function(menu, renderer) {
        var $a, $b, TMP_1, $c, TMP_2, self = this, height = nil, width = nil, stage = nil, texture = nil, bunny = nil, animate = nil;

        height = window.innerHeight;
        width = window.innerWidth;
        stage = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        texture = (($scope.get('PIXI')).$$scope.get('Texture')).$from_image("assets/bunny.png");
        bunny = (($scope.get('PIXI')).$$scope.get('Sprite')).$new(texture);
        (($a = [0.5]), $b = bunny.$anchor(), $b['$x='].apply($b, $a), $a[$a.length-1]);
        (($a = [0.5]), $b = bunny.$anchor(), $b['$y='].apply($b, $a), $a[$a.length-1]);
        (($a = [$rb_divide(width, 2)]), $b = bunny.$position(), $b['$x='].apply($b, $a), $a[$a.length-1]);
        (($a = [$rb_divide(height, 2)]), $b = bunny.$position(), $b['$y='].apply($b, $a), $a[$a.length-1]);
        (($a = [(($scope.get('PIXI')).$$scope.get('Point')).$new(10, 10)]), $b = bunny, $b['$scale='].apply($b, $a), $a[$a.length-1]);
        stage.$add_child(bunny);
        animate = ($a = ($b = $scope.get('Proc')).$new, $a.$$p = (TMP_1 = function(){var self = TMP_1.$$s || this, $a;

        requestAnimationFrame(animate);
          ($a = bunny, $a['$rotation=']($rb_plus($a.$rotation(), 0.01)));
          return renderer.$render(stage);}, TMP_1.$$s = self, TMP_1), $a).call($b);
        stage.$add_child(menu);
        animate.$call();
        return self.destroy = ($a = ($c = $scope.get('Proc')).$new, $a.$$p = (TMP_2 = function(){var self = TMP_2.$$s || this;

        return nil}, TMP_2.$$s = self, TMP_2), $a).call($c);
      }, nil) && 'initialize'
    })(self, (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Base')))
  })($scope.get('PIXI'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["examples/basics/container"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$new', '$pivot=', '$add_child', '$from_image', '$times', '$position=', '$rotation=', '$rotation', '$render', '$call']);
  return (function($base) {
    var self = $module($base, 'Examples');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Container(){};
      var self = $Container = $klass($base, $super, 'Container', $Container);

      var def = self.$$proto, $scope = self.$$scope;

      return (def.$initialize = function(menu, renderer) {
        var $a, $b, TMP_1, $c, TMP_3, $d, TMP_4, self = this, height = nil, width = nil, stage = nil, container = nil, texture = nil, animate = nil;

        height = window.innerHeight;
        width = window.innerWidth;
        stage = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        container = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        (($a = [(($scope.get('PIXI')).$$scope.get('Point')).$new(200, 200)]), $b = container, $b['$pivot='].apply($b, $a), $a[$a.length-1]);
        stage.$add_child(container);
        texture = (($scope.get('PIXI')).$$scope.get('Texture')).$from_image("assets/bunny.png");
        ($a = ($b = (10)).$times, $a.$$p = (TMP_1 = function(x){var self = TMP_1.$$s || this, $a, $b, TMP_2;
if (x == null) x = nil;
        return ($a = ($b = (10)).$times, $a.$$p = (TMP_2 = function(y){var self = TMP_2.$$s || this, $a, $b, bunny = nil;
if (y == null) y = nil;
          bunny = (($scope.get('PIXI')).$$scope.get('Sprite')).$new(texture);
            (($a = [(($scope.get('PIXI')).$$scope.get('Point')).$new($rb_times(40, x), $rb_times(40, y))]), $b = bunny, $b['$position='].apply($b, $a), $a[$a.length-1]);
            return container.$add_child(bunny);}, TMP_2.$$s = self, TMP_2), $a).call($b)}, TMP_1.$$s = self, TMP_1), $a).call($b);
        (($a = [(($scope.get('PIXI')).$$scope.get('Point')).$new($rb_divide(width, 2), $rb_divide(height, 2))]), $c = container, $c['$position='].apply($c, $a), $a[$a.length-1]);
        animate = ($a = ($c = $scope.get('Proc')).$new, $a.$$p = (TMP_3 = function(){var self = TMP_3.$$s || this, $a;

        requestAnimationFrame(animate);
          ($a = container, $a['$rotation=']($rb_plus($a.$rotation(), 0.01)));
          return renderer.$render(stage);}, TMP_3.$$s = self, TMP_3), $a).call($c);
        stage.$add_child(menu);
        animate.$call();
        return self.destroy = ($a = ($d = $scope.get('Proc')).$new, $a.$$p = (TMP_4 = function(){var self = TMP_4.$$s || this;

        return nil}, TMP_4.$$s = self, TMP_4), $a).call($d);
      }, nil) && 'initialize'
    })(self, (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Base')))
  })($scope.get('PIXI'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["examples/basics/spritesheet"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass, $range = Opal.range;

  Opal.add_stubs(['$new', '$rotation=', '$rotation', '$render', '$each', '$sprintf', '$<<', '$from_frame', '$position=', '$anchor=', '$animation_speed=', '$play', '$add_child', '$call']);
  return (function($base) {
    var self = $module($base, 'Examples');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $SpriteSheet(){};
      var self = $SpriteSheet = $klass($base, $super, 'SpriteSheet', $SpriteSheet);

      var def = self.$$proto, $scope = self.$$scope;

      return (def.$initialize = function(menu, renderer) {
        var $a, $b, TMP_1, $c, TMP_2, $d, TMP_4, self = this, height = nil, width = nil, stage = nil, movie = nil, animate = nil, on_assets_loaded = nil;

        height = window.innerHeight;
        width = window.innerWidth;
        stage = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        movie = nil;
        animate = ($a = ($b = $scope.get('Proc')).$new, $a.$$p = (TMP_1 = function(){var self = TMP_1.$$s || this, $a;

        ($a = movie, $a['$rotation=']($rb_plus($a.$rotation(), 0.01)));
          renderer.$render(stage);
          return requestAnimationFrame(animate);}, TMP_1.$$s = self, TMP_1), $a).call($b);
        on_assets_loaded = ($a = ($c = $scope.get('Proc')).$new, $a.$$p = (TMP_2 = function(){var self = TMP_2.$$s || this, $a, $b, TMP_3, $c, frames = nil;

        frames = [];
          ($a = ($b = ($range(0, 30, true))).$each, $a.$$p = (TMP_3 = function(i){var self = TMP_3.$$s || this, val = nil;
if (i == null) i = nil;
          val = self.$sprintf("%02d", i);
            return frames['$<<']((($scope.get('PIXI')).$$scope.get('Texture')).$from_frame($rb_plus($rb_plus("rollSequence00", val), ".png")));}, TMP_3.$$s = self, TMP_3), $a).call($b);
          movie = (((($scope.get('PIXI')).$$scope.get('Extras'))).$$scope.get('MovieClip')).$new(frames);
          (($a = [(($scope.get('PIXI')).$$scope.get('Point')).$new($rb_divide(width, 2), $rb_divide(height, 2))]), $c = movie, $c['$position='].apply($c, $a), $a[$a.length-1]);
          (($a = [(($scope.get('PIXI')).$$scope.get('Point')).$new(0.5, 0.5)]), $c = movie, $c['$anchor='].apply($c, $a), $a[$a.length-1]);
          (($a = [0.5]), $c = movie, $c['$animation_speed='].apply($c, $a), $a[$a.length-1]);
          movie.$play();
          stage.$add_child(movie);
          stage.$add_child(menu);
          return animate.$call();}, TMP_2.$$s = self, TMP_2), $a).call($c);
        PIXI.loader.add('assets/fighter.json').load(on_assets_loaded);
        return self.destroy = ($a = ($d = $scope.get('Proc')).$new, $a.$$p = (TMP_4 = function(){var self = TMP_4.$$s || this;

        return nil}, TMP_4.$$s = self, TMP_4), $a).call($d);
      }, nil) && 'initialize'
    })(self, (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Base')))
  })($scope.get('PIXI'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["examples/basics/click"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$new', '$from_image', '$x=', '$anchor', '$y=', '$position', '$scale=', '$add_child', '$rotation=', '$rotation', '$render', '$scale', '$x', '$y', '$interactive=', '$on', '$call']);
  return (function($base) {
    var self = $module($base, 'Examples');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Click(){};
      var self = $Click = $klass($base, $super, 'Click', $Click);

      var def = self.$$proto, $scope = self.$$scope;

      return (def.$initialize = function(menu, renderer) {
        var $a, $b, TMP_1, $c, TMP_2, $d, TMP_3, self = this, height = nil, width = nil, stage = nil, texture = nil, bunny = nil, animate = nil, onDown = nil;

        height = window.innerHeight;
        width = window.innerWidth;
        stage = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        texture = (($scope.get('PIXI')).$$scope.get('Texture')).$from_image("assets/bunny.png");
        bunny = (($scope.get('PIXI')).$$scope.get('Sprite')).$new(texture);
        (($a = [0.5]), $b = bunny.$anchor(), $b['$x='].apply($b, $a), $a[$a.length-1]);
        (($a = [0.5]), $b = bunny.$anchor(), $b['$y='].apply($b, $a), $a[$a.length-1]);
        (($a = [$rb_divide(width, 2)]), $b = bunny.$position(), $b['$x='].apply($b, $a), $a[$a.length-1]);
        (($a = [$rb_divide(height, 2)]), $b = bunny.$position(), $b['$y='].apply($b, $a), $a[$a.length-1]);
        (($a = [(($scope.get('PIXI')).$$scope.get('Point')).$new(1, 1)]), $b = bunny, $b['$scale='].apply($b, $a), $a[$a.length-1]);
        stage.$add_child(bunny);
        animate = ($a = ($b = $scope.get('Proc')).$new, $a.$$p = (TMP_1 = function(){var self = TMP_1.$$s || this, $a;

        requestAnimationFrame(animate);
          ($a = bunny, $a['$rotation=']($rb_plus($a.$rotation(), 0.01)));
          return renderer.$render(stage);}, TMP_1.$$s = self, TMP_1), $a).call($b);
        onDown = ($a = ($c = $scope.get('Proc')).$new, $a.$$p = (TMP_2 = function(){var self = TMP_2.$$s || this, $a;

        ($a = bunny.$scale(), $a['$x=']($rb_plus($a.$x(), $rb_times(bunny.$scale().$x(), 0.3))));
          return ($a = bunny.$scale(), $a['$y=']($rb_plus($a.$y(), $rb_times(bunny.$scale().$y(), 0.3))));}, TMP_2.$$s = self, TMP_2), $a).call($c);
        (($a = [true]), $d = bunny, $d['$interactive='].apply($d, $a), $a[$a.length-1]);
        bunny.$on("mousedown", onDown);
        bunny.$on("touchstart", onDown);
        stage.$add_child(menu);
        animate.$call();
        return self.destroy = ($a = ($d = $scope.get('Proc')).$new, $a.$$p = (TMP_3 = function(){var self = TMP_3.$$s || this;

        return animate = nil}, TMP_3.$$s = self, TMP_3), $a).call($d);
      }, nil) && 'initialize'
    })(self, (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Base')))
  })($scope.get('PIXI'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["examples/basics/tiling_sprite"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$new', '$from_image', '$width', '$height', '$add_child', '$x=', '$tile_scale', '$y=', '$tile_position', '$x', '$y', '$render', '$call']);
  return (function($base) {
    var self = $module($base, 'Examples');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $TilingSprite(){};
      var self = $TilingSprite = $klass($base, $super, 'TilingSprite', $TilingSprite);

      var def = self.$$proto, $scope = self.$$scope;

      return (def.$initialize = function(menu, renderer) {
        var $a, $b, TMP_1, $c, TMP_2, self = this, height = nil, width = nil, stage = nil, texture = nil, tiling_sprite = nil, count = nil, animate = nil;

        height = window.innerHeight;
        width = window.innerWidth;
        stage = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        texture = (($scope.get('PIXI')).$$scope.get('Texture')).$from_image("assets/p2.jpeg");
        tiling_sprite = (((($scope.get('PIXI')).$$scope.get('Extras'))).$$scope.get('TilingSprite')).$new(texture, renderer.$width(), renderer.$height());
        stage.$add_child(tiling_sprite);
        count = 0;
        animate = ($a = ($b = $scope.get('Proc')).$new, $a.$$p = (TMP_1 = function(){var self = TMP_1.$$s || this, $a, $b;

        count = $rb_plus(count, 0.005);
          (($a = [$rb_plus(2, Math.sin(count))]), $b = tiling_sprite.$tile_scale(), $b['$x='].apply($b, $a), $a[$a.length-1]);
          (($a = [$rb_plus(2, Math.cos(count))]), $b = tiling_sprite.$tile_scale(), $b['$y='].apply($b, $a), $a[$a.length-1]);
          ($a = tiling_sprite.$tile_position(), $a['$x=']($rb_plus($a.$x(), 1)));
          ($a = tiling_sprite.$tile_position(), $a['$y=']($rb_plus($a.$y(), 1)));
          renderer.$render(stage);
          return requestAnimationFrame(animate);}, TMP_1.$$s = self, TMP_1), $a).call($b);
        stage.$add_child(menu);
        animate.$call();
        return self.destroy = ($a = ($c = $scope.get('Proc')).$new, $a.$$p = (TMP_2 = function(){var self = TMP_2.$$s || this;

        return nil}, TMP_2.$$s = self, TMP_2), $a).call($c);
      }, nil) && 'initialize'
    })(self, (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Base')))
  })($scope.get('PIXI'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["examples/basics/text"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass, $hash2 = Opal.hash2;

  Opal.add_stubs(['$new', '$x=', '$width', '$y=', '$height', '$add_child', '$anchor', '$rotation=', '$rotation', '$render', '$call']);
  return (function($base) {
    var self = $module($base, 'Examples');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Text(){};
      var self = $Text = $klass($base, $super, 'Text', $Text);

      var def = self.$$proto, $scope = self.$$scope;

      return (def.$initialize = function(menu, renderer) {
        var $a, $b, TMP_1, self = this, width = nil, height = nil, x_mid = nil, y_mid = nil, stage = nil, basic_text = nil, style = nil, rich_text = nil, count = nil, animate = nil;

        width = window.innerWidth;
        height = window.innerHeight;
        x_mid = $rb_divide(width, 2);
        y_mid = $rb_divide(height, 2);
        stage = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        basic_text = (($scope.get('PIXI')).$$scope.get('Text')).$new("Basic text in pixi");
        (($a = [$rb_minus(x_mid, $rb_divide(basic_text.$width(), 2))]), $b = basic_text, $b['$x='].apply($b, $a), $a[$a.length-1]);
        (($a = [$rb_minus(y_mid, $rb_divide(basic_text.$height(), 2))]), $b = basic_text, $b['$y='].apply($b, $a), $a[$a.length-1]);
        stage.$add_child(basic_text);
        style = $hash2(["font", "fill", "stroke", "strokeThickness", "dropShadow", "dropShadowColor", "dropShadowAngle", "dropShadowDistance", "wordWrap", "wordWrapWidth"], {"font": "bold italic 36px Arial", "fill": "#F7EDCA", "stroke": "#4a1850", "strokeThickness": 5, "dropShadow": true, "dropShadowColor": "#000000", "dropShadowAngle": $rb_divide(Math.PI, 6), "dropShadowDistance": 6, "wordWrap": true, "wordWrapWidth": 440});
        rich_text = (($scope.get('PIXI')).$$scope.get('Text')).$new("Rich text with a lot of options and across multiple lines", style);
        (($a = [x_mid]), $b = rich_text, $b['$x='].apply($b, $a), $a[$a.length-1]);
        (($a = [y_mid]), $b = rich_text, $b['$y='].apply($b, $a), $a[$a.length-1]);
        (($a = [0.5]), $b = rich_text.$anchor(), $b['$x='].apply($b, $a), $a[$a.length-1]);
        (($a = [0.5]), $b = rich_text.$anchor(), $b['$y='].apply($b, $a), $a[$a.length-1]);
        stage.$add_child(rich_text);
        count = 0;
        animate = ($a = ($b = $scope.get('Proc')).$new, $a.$$p = (TMP_1 = function(){var self = TMP_1.$$s || this, $a, $b;

        count = $rb_plus(count, 0.01);
          requestAnimationFrame(animate);
          (($a = [$rb_plus(x_mid, ($rb_times(Math.sin(count), ($rb_minus(x_mid, $rb_divide(rich_text.$width(), 2))))))]), $b = rich_text, $b['$x='].apply($b, $a), $a[$a.length-1]);
          (($a = [$rb_plus(y_mid, ($rb_times(Math.cos(count), ($rb_minus(y_mid, $rb_divide(rich_text.$height(), 2))))))]), $b = rich_text, $b['$y='].apply($b, $a), $a[$a.length-1]);
          ($a = rich_text, $a['$rotation=']($rb_plus($a.$rotation(), 0.01)));
          return renderer.$render(stage);}, TMP_1.$$s = self, TMP_1), $a).call($b);
        stage.$add_child(menu);
        return animate.$call();
      }, nil) && 'initialize'
    })(self, (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Base')))
  })($scope.get('PIXI'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["examples/basics/graphics"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$new', '$interactive=', '$begin_fill', '$line_style', '$move_to', '$line_to', '$end_fill', '$draw_rect', '$draw_rounded_rect', '$draw_circle', '$add_child', '$render', '$call']);
  return (function($base) {
    var self = $module($base, 'Examples');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Graphics(){};
      var self = $Graphics = $klass($base, $super, 'Graphics', $Graphics);

      var def = self.$$proto, $scope = self.$$scope;

      return (def.$initialize = function(menu, renderer) {
        var $a, $b, TMP_1, $c, TMP_2, self = this, height = nil, width = nil, stage = nil, graphics = nil, animate = nil;

        height = window.innerHeight;
        width = window.innerWidth;
        stage = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        (($a = [true]), $b = stage, $b['$interactive='].apply($b, $a), $a[$a.length-1]);
        graphics = (($scope.get('PIXI')).$$scope.get('Graphics')).$new();
        graphics.$begin_fill(16724736);
        graphics.$line_style(4, 16767232, 1);
        graphics.$move_to(50, 50);
        graphics.$line_to(250, 50);
        graphics.$line_to(100, 100);
        graphics.$line_to(50, 50);
        graphics.$end_fill();
        graphics.$line_style(2, 255, 1);
        graphics.$begin_fill(16740363, 1);
        graphics.$draw_rect(50, 250, 120, 120);
        graphics.$line_style(2, 16711935, 1);
        graphics.$begin_fill(16711867, 0.25);
        graphics.$draw_rounded_rect(150, 450, 300, 100, 15);
        graphics.$end_fill();
        graphics.$line_style(0);
        graphics.$begin_fill(16776971, 0.5);
        graphics.$draw_circle(470, 90, 60);
        graphics.$end_fill();
        stage.$add_child(graphics);
        animate = ($a = ($b = $scope.get('Proc')).$new, $a.$$p = (TMP_1 = function(){var self = TMP_1.$$s || this;

        requestAnimationFrame(animate);
          return renderer.$render(stage);}, TMP_1.$$s = self, TMP_1), $a).call($b);
        stage.$add_child(menu);
        animate.$call();
        return self.destroy = ($a = ($c = $scope.get('Proc')).$new, $a.$$p = (TMP_2 = function(){var self = TMP_2.$$s || this;

        return nil}, TMP_2.$$s = self, TMP_2), $a).call($c);
      }, nil) && 'initialize'
    })(self, (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Base')))
  })($scope.get('PIXI'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["examples/basics/video"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$new', '$from_video', '$width=', '$width', '$height=', '$height', '$add_child', '$render', '$call']);
  return (function($base) {
    var self = $module($base, 'Examples');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Video(){};
      var self = $Video = $klass($base, $super, 'Video', $Video);

      var def = self.$$proto, $scope = self.$$scope;

      return (def.$initialize = function(menu, renderer) {
        var $a, $b, TMP_1, $c, TMP_2, self = this, height = nil, width = nil, stage = nil, texture = nil, video_sprite = nil, animate = nil;

        height = window.innerHeight;
        width = window.innerWidth;
        stage = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        texture = (($scope.get('PIXI')).$$scope.get('Texture')).$from_video("assets/testVideo.mp4");
        video_sprite = (($scope.get('PIXI')).$$scope.get('Sprite')).$new(texture);
        (($a = [renderer.$width()]), $b = video_sprite, $b['$width='].apply($b, $a), $a[$a.length-1]);
        (($a = [renderer.$height()]), $b = video_sprite, $b['$height='].apply($b, $a), $a[$a.length-1]);
        stage.$add_child(video_sprite);
        animate = ($a = ($b = $scope.get('Proc')).$new, $a.$$p = (TMP_1 = function(){var self = TMP_1.$$s || this;

        requestAnimationFrame(animate);
          return renderer.$render(stage);}, TMP_1.$$s = self, TMP_1), $a).call($b);
        stage.$add_child(menu);
        animate.$call();
        return self.destroy = ($a = ($c = $scope.get('Proc')).$new, $a.$$p = (TMP_2 = function(){var self = TMP_2.$$s || this;

        return cancelAnimationFrame(animate);}, TMP_2.$$s = self, TMP_2), $a).call($c);
      }, nil) && 'initialize'
    })(self, (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Base')))
  })($scope.get('PIXI'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["examples/basics/render_texture"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$new', '$pivot=', '$add_child', '$from_image', '$times', '$position=', '$rotation=', '$height', '$rotation', '$render', '$call']);
  return (function($base) {
    var self = $module($base, 'Examples');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $RenderTexture(){};
      var self = $RenderTexture = $klass($base, $super, 'RenderTexture', $RenderTexture);

      var def = self.$$proto, $scope = self.$$scope;

      return (def.$initialize = function(menu, renderer) {
        var $a, $b, TMP_1, $c, TMP_3, $d, TMP_4, self = this, height = nil, width = nil, stage = nil, container = nil, texture = nil, rt = nil, sprite = nil, animate = nil;

        height = window.innerHeight;
        width = window.innerWidth;
        stage = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        container = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        (($a = [(($scope.get('PIXI')).$$scope.get('Point')).$new(200, 200)]), $b = container, $b['$pivot='].apply($b, $a), $a[$a.length-1]);
        stage.$add_child(container);
        texture = (($scope.get('PIXI')).$$scope.get('Texture')).$from_image("assets/bunny.png");
        ($a = ($b = (5)).$times, $a.$$p = (TMP_1 = function(x){var self = TMP_1.$$s || this, $a, $b, TMP_2;
if (x == null) x = nil;
        return ($a = ($b = (5)).$times, $a.$$p = (TMP_2 = function(y){var self = TMP_2.$$s || this, $a, $b, bunny = nil;
if (y == null) y = nil;
          bunny = (($scope.get('PIXI')).$$scope.get('Sprite')).$new(texture);
            (($a = [(($scope.get('PIXI')).$$scope.get('Point')).$new($rb_times(20, x), $rb_times(20, y))]), $b = bunny, $b['$position='].apply($b, $a), $a[$a.length-1]);
            (($a = [$rb_times(Math.random(), ($rb_times(Math.PI, 2)))]), $b = bunny, $b['$rotation='].apply($b, $a), $a[$a.length-1]);
            return container.$add_child(bunny);}, TMP_2.$$s = self, TMP_2), $a).call($b)}, TMP_1.$$s = self, TMP_1), $a).call($b);
        (($a = [(($scope.get('PIXI')).$$scope.get('Point')).$new($rb_divide(width, 2), $rb_divide(height, 2))]), $c = container, $c['$position='].apply($c, $a), $a[$a.length-1]);
        rt = (($scope.get('PIXI')).$$scope.get('RenderTexture')).$new(renderer, 200, 200, PIXI.SCALE_MODES.LINEAR, 0.6);
        sprite = (($scope.get('PIXI')).$$scope.get('Sprite')).$new(rt);
        (($a = [(($scope.get('PIXI')).$$scope.get('Point')).$new($rb_divide(width, 2), $rb_plus($rb_divide(height, 2), container.$height()))]), $c = sprite, $c['$position='].apply($c, $a), $a[$a.length-1]);
        (($a = [(($scope.get('PIXI')).$$scope.get('Point')).$new(15, 15)]), $c = sprite, $c['$pivot='].apply($c, $a), $a[$a.length-1]);
        stage.$add_child(sprite);
        animate = ($a = ($c = $scope.get('Proc')).$new, $a.$$p = (TMP_3 = function(){var self = TMP_3.$$s || this, $a;

        requestAnimationFrame(animate);
          ($a = sprite, $a['$rotation=']($rb_plus($a.$rotation(), 0.01)));
          rt.$render(container);
          return renderer.$render(stage);}, TMP_3.$$s = self, TMP_3), $a).call($c);
        stage.$add_child(menu);
        animate.$call();
        return self.destroy = ($a = ($d = $scope.get('Proc')).$new, $a.$$p = (TMP_4 = function(){var self = TMP_4.$$s || this;

        return nil}, TMP_4.$$s = self, TMP_4), $a).call($d);
      }, nil) && 'initialize'
    })(self, (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Base')))
  })($scope.get('PIXI'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["examples/basics/textured_mesh"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass;

  Opal.add_stubs(['$new', '$upto', '$<<', '$from_image', '$x=', '$position', '$y=', '$add_child', '$x', '$y', '$clear', '$line_style', '$move_to', '$[]', '$each', '$line_to', '$begin_fill', '$draw_circle', '$end_fill', '$each_with_index', '$render', '$call']);
  return (function($base) {
    var self = $module($base, 'Examples');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $TexturedMesh(){};
      var self = $TexturedMesh = $klass($base, $super, 'TexturedMesh', $TexturedMesh);

      var def = self.$$proto, $scope = self.$$scope;

      return (def.$initialize = function(menu, renderer) {
        var $a, $b, TMP_1, $c, TMP_2, $d, TMP_5, $e, TMP_7, self = this, height = nil, width = nil, stage = nil, rope_length = nil, points = nil, strip = nil, g = nil, count = nil, render_points = nil, animate = nil;

        height = window.innerHeight;
        width = window.innerWidth;
        stage = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        rope_length = $rb_divide(918, 40);
        rope_length = 45;
        points = [];
        ($a = ($b = (0)).$upto, $a.$$p = (TMP_1 = function(x){var self = TMP_1.$$s || this;
if (x == null) x = nil;
        return points['$<<']((($scope.get('PIXI')).$$scope.get('Point')).$new($rb_times(x, rope_length), 0))}, TMP_1.$$s = self, TMP_1), $a).call($b, 45);
        strip = (((($scope.get('PIXI')).$$scope.get('Mesh'))).$$scope.get('Rope')).$new((($scope.get('PIXI')).$$scope.get('Texture')).$from_image("assets/snake.png"), points);
        (($a = [-100]), $c = strip.$position(), $c['$x='].apply($c, $a), $a[$a.length-1]);
        (($a = [300]), $c = strip.$position(), $c['$y='].apply($c, $a), $a[$a.length-1]);
        stage.$add_child(strip);
        g = (($scope.get('PIXI')).$$scope.get('Graphics')).$new();
        (($a = [strip.$x()]), $c = g, $c['$x='].apply($c, $a), $a[$a.length-1]);
        (($a = [strip.$y()]), $c = g, $c['$y='].apply($c, $a), $a[$a.length-1]);
        stage.$add_child(g);
        count = 0;
        render_points = ($a = ($c = $scope.get('Proc')).$new, $a.$$p = (TMP_2 = function(){var self = TMP_2.$$s || this, $a, $b, TMP_3, $c, TMP_4;

        g.$clear();
          g.$line_style(2, 16761538);
          g.$move_to(points['$[]'](0).$x(), points['$[]'](0).$y());
          ($a = ($b = points).$each, $a.$$p = (TMP_3 = function(point){var self = TMP_3.$$s || this;
if (point == null) point = nil;
          g.$line_to(point.$x(), point.$y());
            return g.$move_to(point.$x(), point.$y());}, TMP_3.$$s = self, TMP_3), $a).call($b);
          return ($a = ($c = points).$each, $a.$$p = (TMP_4 = function(point){var self = TMP_4.$$s || this;
if (point == null) point = nil;
          g.$begin_fill(16711714);
            g.$draw_circle(point.$x(), point.$y(), 4);
            return g.$end_fill();}, TMP_4.$$s = self, TMP_4), $a).call($c);}, TMP_2.$$s = self, TMP_2), $a).call($c);
        animate = ($a = ($d = $scope.get('Proc')).$new, $a.$$p = (TMP_5 = function(){var self = TMP_5.$$s || this, $a, $b, TMP_6;

        count = $rb_plus(count, 0.1);
          ($a = ($b = points).$each_with_index, $a.$$p = (TMP_6 = function(point, i){var self = TMP_6.$$s || this, $a, $b;
if (point == null) point = nil;if (i == null) i = nil;
          (($a = [$rb_times(Math.sin((i * 0.5) + count), 30)]), $b = point, $b['$y='].apply($b, $a), $a[$a.length-1]);
            return (($a = [$rb_plus($rb_times(i, rope_length), $rb_times(Math.cos((i * 0.3) + count), 20))]), $b = point, $b['$x='].apply($b, $a), $a[$a.length-1]);}, TMP_6.$$s = self, TMP_6), $a).call($b);
          renderer.$render(stage);
          render_points.$call();
          return requestAnimationFrame(animate);}, TMP_5.$$s = self, TMP_5), $a).call($d);
        stage.$add_child(menu);
        animate.$call();
        return self.destroy = ($a = ($e = $scope.get('Proc')).$new, $a.$$p = (TMP_7 = function(){var self = TMP_7.$$s || this;

        return nil}, TMP_7.$$s = self, TMP_7), $a).call($e);
      }, nil) && 'initialize'
    })(self, (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Base')))
  })($scope.get('PIXI'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["examples/basics/custom_filter"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass, $hash2 = Opal.hash2;

  Opal.add_stubs(['$new', '$from_image', '$set', '$scale', '$add_child', '$x=', '$y=', '$customUniform', '$uniforms', '$value=', '$value', '$render', '$filters=', '$call']);
  return (function($base) {
    var self = $module($base, 'Examples');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $CustomFilter(){};
      var self = $CustomFilter = $klass($base, $super, 'CustomFilter', $CustomFilter);

      var def = self.$$proto, $scope = self.$$scope;

      return (def.$initialize = function(menu, renderer) {
        var $a, $b, TMP_2, $c, TMP_3, $d, TMP_4, self = this, height = nil, width = nil, stage = nil, container = nil, background = nil, filter = nil, animate = nil, on_assets_loaded = nil;

        height = window.innerHeight;
        width = window.innerWidth;
        stage = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        container = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        (function($base, $super) {
          function $ACustomFilter(){};
          var self = $ACustomFilter = $klass($base, $super, 'ACustomFilter', $ACustomFilter);

          var def = self.$$proto, $scope = self.$$scope, TMP_1;

          return (def.$initialize = TMP_1 = function(fragmentSource) {
            var self = this, $iter = TMP_1.$$p, $yield = $iter || nil, shader = nil, uniforms = nil;

            TMP_1.$$p = null;
            shader = null;
            uniforms = $hash2(["customUniform"], {"customUniform": $hash2(["type", "value"], {"type": "1f", "value": 10})});
            return Opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [shader, fragmentSource, uniforms]);
          }, nil) && 'initialize'
        })(self, (($scope.get('PIXI')).$$scope.get('AbstractFilter')));
        background = (($scope.get('PIXI')).$$scope.get('Sprite')).$from_image("assets/bkg-grass.jpg");
        background.$scale().$set(1.3, 1);
        container.$add_child(background);
        (($a = [280]), $b = container, $b['$x='].apply($b, $a), $a[$a.length-1]);
        (($a = [100]), $b = container, $b['$y='].apply($b, $a), $a[$a.length-1]);
        stage.$add_child(container);
        filter = nil;
        animate = ($a = ($b = $scope.get('Proc')).$new, $a.$$p = (TMP_2 = function(){var self = TMP_2.$$s || this, $a;

        ($a = filter.$uniforms().$customUniform(), $a['$value=']($rb_plus($a.$value(), 0.04)));
          renderer.$render(stage);
          return requestAnimationFrame(animate);}, TMP_2.$$s = self, TMP_2), $a).call($b);
        on_assets_loaded = ($a = ($c = $scope.get('Proc')).$new, $a.$$p = (TMP_3 = function(loader, res){var self = TMP_3.$$s || this, $a, $b, fragmentSrc = nil;
if (loader == null) loader = nil;if (res == null) res = nil;
        fragmentSrc = res.shader.data;
          filter = $scope.get('ACustomFilter').$new(fragmentSrc);
          (($a = [[filter]]), $b = background, $b['$filters='].apply($b, $a), $a[$a.length-1]);
          return animate.$call();}, TMP_3.$$s = self, TMP_3), $a).call($c);
        stage.$add_child(menu);
        PIXI.loader.add('shader','assets/shader.frag');
        PIXI.loader.once('complete',on_assets_loaded);
        PIXI.loader.load();
        return self.destroy = ($a = ($d = $scope.get('Proc')).$new, $a.$$p = (TMP_4 = function(){var self = TMP_4.$$s || this;

        return nil}, TMP_4.$$s = self, TMP_4), $a).call($d);
      }, nil) && 'initialize'
    })(self, (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Base')))
  })($scope.get('PIXI'))
};

/* Generated by Opal 0.8.0 */
Opal.modules["examples"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$require']);
  self.$require("examples/basics/base");
  self.$require("examples/basics/basic");
  self.$require("examples/basics/container");
  self.$require("examples/basics/spritesheet");
  self.$require("examples/basics/click");
  self.$require("examples/basics/tiling_sprite");
  self.$require("examples/basics/text");
  self.$require("examples/basics/graphics");
  self.$require("examples/basics/video");
  self.$require("examples/basics/render_texture");
  self.$require("examples/basics/textured_mesh");
  return self.$require("examples/basics/custom_filter");
};

/* Generated by Opal 0.8.0 */
(function(Opal) {
  Opal.dynamic_require_severity = "error";
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass, $hash2 = Opal.hash2;

  Opal.add_stubs(['$require', '$include', '$new', '$Native', '$appendChild', '$view', '$each_with_index', '$downcase', '$last', '$split', '$name', '$x=', '$y=', '$interactive=', '$on', '$call', '$add_child', '$first']);
  self.$require("opal");
  self.$require("opal-pixi");
  self.$require("native");
  self.$require("examples");
  self.$require("examples/basics/basic");
  return (function($base) {
    var self = $module($base, 'PIXI');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Demo(){};
      var self = $Demo = $klass($base, $super, 'Demo', $Demo);

      var def = self.$$proto, $scope = self.$$scope;

      self.$include($scope.get('Native'));

      return (def.$initialize = function() {
        var $a, $b, TMP_1, $c, TMP_2, self = this, examples = nil, height = nil, width = nil, renderer = nil, body = nil, menu = nil, current = nil, show_content = nil, style = nil;

        examples = [(((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Basic')), (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Click')), (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Container')), (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('CustomFilter')), (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Graphics')), (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('RenderTexture')), (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('SpriteSheet')), (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Text')), (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('TexturedMesh')), (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('TilingSprite')), (((($scope.get('PIXI')).$$scope.get('Examples'))).$$scope.get('Video'))];
        height = window.innerHeight;
        width = window.innerWidth;
        renderer = (($scope.get('PIXI')).$$scope.get('WebGLRenderer')).$new(width, height, $hash2(["backgroundColor"], {"backgroundColor": 1118481}));
        body = self.$Native(window.document.body);
        body.$appendChild(renderer.$view());
        menu = (($scope.get('PIXI')).$$scope.get('Container')).$new();
        current = nil;
        show_content = ($a = ($b = $scope.get('Proc')).$new, $a.$$p = (TMP_1 = function(item){var self = TMP_1.$$s || this;
if (item == null) item = nil;
        return current = item.$new(menu, renderer)}, TMP_1.$$s = self, TMP_1), $a).call($b);
        style = $hash2(["font", "fill", "stroke", "strokeThickness", "dropShadow", "dropShadowColor", "dropShadowAngle", "dropShadowDistance", "wordWrap", "wordWrapWidth"], {"font": "bold italic 36px Arial", "fill": "#F7EDCA", "stroke": "#4a1850", "strokeThickness": 5, "dropShadow": true, "dropShadowColor": "#000000", "dropShadowAngle": $rb_divide(Math.PI, 6), "dropShadowDistance": 6, "wordWrap": true, "wordWrapWidth": 440});
        ($a = ($c = examples).$each_with_index, $a.$$p = (TMP_2 = function(item, index){var self = TMP_2.$$s || this, $a, $b, TMP_3, menu_item = nil;
if (item == null) item = nil;if (index == null) index = nil;
        menu_item = (($scope.get('PIXI')).$$scope.get('Text')).$new(item.$name().$split("::").$last().$downcase(), style);
          (($a = [10]), $b = menu_item, $b['$x='].apply($b, $a), $a[$a.length-1]);
          (($a = [$rb_times(50, index)]), $b = menu_item, $b['$y='].apply($b, $a), $a[$a.length-1]);
          (($a = [true]), $b = menu_item, $b['$interactive='].apply($b, $a), $a[$a.length-1]);
          ($a = ($b = menu_item).$on, $a.$$p = (TMP_3 = function(){var self = TMP_3.$$s || this;

          return show_content.$call(item)}, TMP_3.$$s = self, TMP_3), $a).call($b, "mousedown");
          return menu.$add_child(menu_item);}, TMP_2.$$s = self, TMP_2), $a).call($c);
        return show_content.$call(examples.$first());
      }, nil) && 'initialize';
    })(self, null)
  })(self);
})(Opal);
