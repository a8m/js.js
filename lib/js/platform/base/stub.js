var assert = require('assert');
var heap = require('heap.js');

function Stub(name, body, config) {
  this.name = name;
  this.body = body;
  this.fn = null;
  this.config = config || {};
  this.ic = this.config.ic || null;
};
exports.Stub = Stub;

Stub.prototype.ptr = function ptr() {
  return this.fn.ptr();
};

exports.extend = function extend(Base) {
  Base.prototype.initStubs = initStubs;
  Base.prototype.declareStub = declareStub;
  Base.prototype.registerStub = registerStub;
  Base.prototype.getStub = getStub;
};

function initStubs() {
  propertyStubs.call(this);
  allocStubs.call(this);
  constructStubs.call(this);
  typeStubs.call(this);
  unaryStubs.call(this);
  binaryStubs.call(this);
}

function declareStub(name, body, config) {
  this.cfgStubs[name] = new this.Stub(name, body, config);
};

function registerStub(stub) {
  this.cfgStubs[stub.name] = stub;
};

function getStub(name) {
  var stub = this.cfgStubs[name];
  assert(stub, 'CFG Stub ' + name + ' not found');
  if (stub.fn !== null)
    return stub;

  var body = stub.body;
  var res;
  this.runtime.persistent.wrap(function() {
    res = this.runtime.compiler.compileCFG(body, stub.config);
  }, this);

  stub.fn = res;
  return stub;
};

//
// Stub declarations
//

function propertyStubs() {
  var Object = heap.entities.Object;
  var Field = heap.entities.Field;
  var KeyDict = heap.entities.dict.Key;

  this.declareStub('getPropertySlot_Miss', function() {/*
    block GetPropertySlot_Miss
      ic = ic
      obj = loadStubArg %0
      prop = loadStubArg %1
      update = loadStubArg %2

      rtId = runtimeId %"getPropertySlot"

      pushArg update
      pushArg prop
      pushArg obj
      pushArg ic
      pushArg rtId

      res = callStub %"stub", %"runtime", %5
      ret res
  */});

  // TODO(indutny): support delete
  var ops = [ 'load', 'store', 'delete' ];
  ops.forEach(function(op) {
    this.declareStub(op + 'PropertySlot', function() {/*
      block OpPropertySlot -> Access, NoAccess
        obj = loadStubArg %0
        key = loadStubArg %1
        slot = loadStubArg %2
        #if op === 'store'
          value = loadStubArg %3
        #endif

        // If object has AccessPair - perform runtime lookup
        oflags = readTagged obj, %{Object.offsets.flags}
        access = literal %{Object.flags.access}
        smiTest oflags, access

      block NoAccess -> Found, NotFound
        isSmi slot

      block Access -> PreRuntime
        // Just do a runtime call

      block Found -> Dense, Key
        dense = literal %{Object.flags.dense}
        smiTest oflags, dense

      block Dense -> Op
        // slot = off + slot
        t0 = literal %{ptrShift}
        t1 = smiShl slot, t0
        t2 = literal %{Field.offsets.field}
        t3 = smiAdd t1, t2
        to_phi off, t3

      block Key -> Op
        // slot = off + slot * {KeyDict.offsets.itemSize} +
        //        {KeyDict.offsets.value}
        t4 = literal %{KeyDict.offsets.itemSize}
        t5 = smiMul slot, t4
        t6 = literal %{KeyDict.offsets.value}
        t7 = smiAdd t5, t6
        t8 = literal %{ptrShift}
        t9 = smiShl t7, t8
        t10 = literal %{Field.offsets.field}
        t11 = smiAdd t9, t10

        to_phi off, t11

      block Op
        off = phi
        field = readTagged obj, %{Object.offsets.field}
        #if op === 'load'
          res = smiReadTagged field, off
          ret res
        #elif op === 'store'
          smiWriteTagged field, value, off
          res = literal %undefined
          ret res
        #else
          brk
        #endif

      block NotFound -> Runtime
        #if op === 'store'
          // Unreachable
          brk
        #elif op === 'delete'
          // Should be undefined
          ret slot
        #endif

      block PreRuntime -> Runtime
      block Runtime
        // Fallback to runtime property lookup, the value might be
        // in the prototype chain
        rtId = runtimeId %{op + "Property"}
        #if op === 'store'
          pushArg value
        #endif
        pushArg key
        pushArg obj
        pushArg rtId
        #if op === 'store'
          rres = callStub %"stub", %"runtime", %4
        #else
          rres = callStub %"stub", %"runtime", %3
        #endif
        ret rres
    */}, {
      locals: {
        op: op,
        Field: Field,
        Object: Object,
        KeyDict: KeyDict,

        ptrShift: heap.ptrShift
      }
    });
  }, this);
}

function allocStubs() {
  var Base = heap.entities.Base;
  var Map = heap.entities.Map;
  var Field = heap.entities.Field;
  var Object = heap.entities.Object;
  var Function = heap.entities.Function;
  var AccessPair = heap.entities.AccessPair;

  this.declareStub('allocField', function() {/*
    block AllocField
      base = literal %{Field.size(0)}
      size = loadStubArg %0

      shift = literal %{Field.shifts.field}
      t1 = smiShl size, shift
      ssize = smiAdd base, t1

      pushArg ssize
      field = callStub %"stub", %"allocTagged/field", %1

      writeTagged field, size, %{Field.offsets.size}

      t3 = literal %{Field.offsets.field}
      t4 = smiUntag t3
      start = pointerAdd field, t4
      t5 = smiUntag ssize
      end = pointerAdd field, t5

      hole = hole
      pointerFill start, end, hole

      ret field
  */}, {
    locals: {
      Field: Field
    }
  });

  this.declareStub('allocObject', function() {/*
    block AllocObject
      size = literal %{Object.size()}
      pushArg size
      obj = callStub %"stub", %"allocTagged/object", %1

      // Object.call(this)
      pushArg obj
      callStub %"stub", %"Object", %1

      ret obj
  */}, {
    locals: {
      Object: Object
    }
  });

  this.declareStub('allocFn', function() {/*
    block AllocFn
      // Calculate context size
      slots = loadStubArg %2
      ptrShift = literal %{ptrShift}
      contextSize = smiShl slots, ptrShift
      preSize = literal %{Function.size(0)}

      // Get total tagged entity size
      size = smiAdd preSize, contextSize
      pushArg size
      fn = callStub %"stub", %"allocTagged/function", %1

      // Object.call(this)
      pushArg fn
      callStub %"stub", %"Object", %1

      // Function.call(this, code, slots)
      code = loadStubArg %0
      outer = loadStubArg %1
      pushArg slots
      pushArg outer
      pushArg code
      pushArg fn
      callStub %"stub", %"Function", %4

      ret fn
  */}, {
    locals: {
      Function: Function,
      ptrShift: heap.ptrShift
    }
  });

  this.declareStub('allocAccessPair', function() {/*
    block AllocAccessPair
      size = literal %{AccessPair.size()}
      pushArg size
      ap = callStub %"stub", %"allocTagged/access-pair", %1

      // Set default setter/getter/attributes
      hole = hole
      writeTagged ap, hole, %{AccessPair.offsets.getter}
      writeTagged ap, hole, %{AccessPair.offsets.setter}
      attrs = literal %{AccessPair.attributes['default']}
      writeTagged ap, attrs, %{AccessPair.offsets.attributes}

      ret ap
  */}, {
    locals: {
      AccessPair: AccessPair
    }
  });

  this.declareStub('new', function() {/*
    block New
      argc = loadStubArg %0
      fn = loadStubArg %1
      pushArg fn
      callStub %"stub", %"checkFunction", %1

      res = callStub %"stub", %"allocObject", %0

      map = readTagged fn, %{Function.offsets.instanceMap}
      writeTagged res, map, %{Base.offsets.map}

      // Invoke the constructor
      repushArgs argc, %2
      alt = smiCall fn, res, argc

      // TODO(indutny): check return value of constructor

      ret res
  */}, {
    locals: {
      Base: Base,
      Function: Function
    }
  });

  var types = [
    'map',
    'boolean',
    'field',
    'object',
    'function',
    'access-pair'
  ];
  types.forEach(function(type) {
    this.declareStub('allocTagged/' + type, function() {/*
      block AllocTagged -> HasSpace, NeedGC
        t0 = loadStubArg %0
        t1 = smiUntag t0
        size = heap.alignSize t1

        current = heap.current
        limit = heap.limit
        after = pointerAdd current, size
        pointerCompare %"<=", after, limit

      block HasSpace
        heap.setCurrent after
        map = map %{type}
        writeTagged current, map, %{Base.offsets.map}

        ret current

      block NeedGC
        // Allocation not possible at the time
        // TODO(indutny): call runtime
        brk
    */}, {
      locals: {
        type: type,
        Base: Base
      }
    });
  }, this);
}

function constructStubs() {
  var Map = heap.entities.Map;
  var Object = heap.entities.Object;
  var Function = heap.entities.Function;
  var Code = heap.entities.Code;
  var AccessPair = heap.entities.AccessPair;
  var KeyDict = heap.entities.dict.Key;

  this.declareStub('Object', function() {/*
    block Object
      self = loadStubArg %0
      size = literal %{Object.minSize}

      // HashMap needs 3x field
      itemSize = literal %{KeyDict.offsets.itemSize}
      ssize = smiMul size, itemSize

      pushArg ssize
      hashmap = callStub %"stub", %"allocField", %1
      writeTagged self, hashmap, %{Object.offsets.field}

      flags = literal %{Object.flags['default']}
      writeTagged self, flags, %{Object.offsets.flags}

      ret self
  */}, {
    locals: {
      Object: Object,
      KeyDict: KeyDict
    }
  });

  this.declareStub('Function', function() {/*
    block Function
      fn = loadStubArg %0
      code = loadStubArg %1

      // Store code
      writeInterior fn, code, %{Function.offsets.code}, %{Code.offsets.code}

      // Context size
      // TODO(indutny): support context
      zero = literal %0
      writeTagged fn, zero, %{Function.offsets.context.size}

      // Create getter/setter for `prototype`
      ap = callStub %"stub", %"allocAccessPair", %0

      getter = stub %"FunctionProtoGetter"
      writeTagged ap, getter, %{AccessPair.offsets.getter}
      setter = stub %"FunctionProtoSetter"
      writeTagged ap, setter, %{AccessPair.offsets.setter}

      // NOTE: storeProperty is replaced with a stub call here
      prop = literal %"prototype"
      storeProperty fn, prop, ap

      // Set access flag on object to trigger runtime lookups
      oflags = readTagged fn, %{Object.offsets.flags}
      access = literal %{Object.flags.access}
      newFlags = smiOr oflags, access
      writeTagged fn, newFlags, %{Object.offsets.flags}

      // Invoke setter
      proto = object %0
      pushArg proto
      imap = call setter, fn, %1

      // Set outer context
      outer = loadStubArg %2
      writeTagged fn, outer, %{Function.offsets.outer}

      // Fill the context with undefined
      slots = loadStubArg %3
      ptrShift = literal %{ptrShift}
      contextSize = smiShl slots, ptrShift

      fieldOff = literal %{Function.offsets.context.field}
      start = pointerAdd fn, fieldOff
      end = pointerAdd start, contextSize

      undef = literal %undefined
      pointerFill start, end, undef

      ret fn
  */}, {
    locals: {
      Code: Code,
      Function: Function,
      Map: Map,
      Object: Object,
      AccessPair: AccessPair,

      ptrShift: heap.ptrShift
    }
  });

  this.declareStub('FunctionProtoGetter', function() {/*
    block FunctionProtoGetter
      this = this
      imap = readTagged this, %{Function.offsets.instanceMap}
      proto = readTagged imap, %{Map.offsets.proto}
      ret proto
  */}, {
    locals: {
      Function: Function,
      Map: Map
    }
  });

  this.declareStub('FunctionProtoSetter', function() {/*
    block FunctionProtoSetter
      proto = loadArg %0
      this = this

      // Allocate instance map
      mapSize = literal %{Map.size()}
      pushArg mapSize
      imap = callStub %"stub", %"allocTagged/map", %1

      // Fill the map, it won't really be used for transitions and stuff
      // like that anyway
      hole = hole
      writeTagged imap, hole, %{Map.offsets.edges}
      writeTagged imap, hole, %{Map.offsets.transitionCount}

      flags = literal %{Map.flags.default}
      writeTagged imap, flags, %{Map.offsets.flags}

      // Set map's prototype
      writeTagged imap, proto, %{Map.offsets.proto}
      writeTagged this, imap, %{Function.offsets.instanceMap}

      ret this
  */}, {
    locals: {
      Function: Function,
      Map: Map
    }
  });
}

function typeStubs() {
  var Base = heap.entities.Base;
  var Map = heap.entities.Map;

  this.declareStub('checkFunction', function() {/*
    block IsFunction -> Smi, NonSmi
      obj = loadStubArg %0
      isSmi obj

     block NonSmi -> Ok, NotOk
       map = readTagged obj, %{Base.offsets.map}
       actual = readTagged map, %{Map.offsets.flags}
       expected = literal %{Map.flags.fn}
       smiTest actual, expected

     block Ok
       ret

     block Smi -> NotOk
     block NotOk
       brk
  */}, {
    locals: {
      Base: Base,
      Map: Map
    }
  });

  var types = [
    'boolean'
  ];
  types.forEach(function(type) {
    this.declareStub('coerce/' + type, function() {/*
      block Coerce -> Smi, NonSmi
        val = loadStubArg %0
        isSmi val

      block Smi -> True, False
        zero = literal %0
        smiCompare %"!=", val, zero

      block True
        r0 = literal %true
        ret r0

      block False
        r1 = literal %false
        ret r1

      block NonSmi -> Same, NotSame
        actual = readTagged val, %{Base.offsets.map}
        expected = map %{type}
        pointerCompare %"==", expected, actual

      block Same
        ret val

      block NotSame
        rtId = runtimeId %{runtime}
        pushArg val
        pushArg rtId
        r2 = callStub %"stub", %"runtime", %2
        ret r2
    */}, {
      locals: {
        type: type,
        runtime: 'coerce/' + type,
        Base: Base
      }
    });
  }, this);
}

function unaryStubs() {
  var ops = [ '-' ];
  ops.forEach(function(op) {
    this.declareStub('unary/' + op, function() {/*
      block UnaryExpression -> SrcSmi, SrcNonSmi
        src = loadStubArg %0
        isSmi src

      block SrcSmi -> Overflow, Success
        #if op === '-'
          r = smiNeg src
        #else
          brk
        #endif
        checkOverflow

      block Success
        ret r

      block SrcNonSmi -> Overflow
      block Overflow
        // not SMI
        brk
    */}, {
      locals: {
        op: op
      }
    });
  }, this);
}

function binaryStubs() {
  var Base = heap.entities.Base;
  var Function = heap.entities.Function;
  var Map = heap.entities.Map;

  var ops = [ '+', '-', '*' ];
  ops.forEach(function(op) {
    this.declareStub('binary/' + op, function() {/*
      block BinaryMath -> LeftSmi, LeftNonSmi
        left = loadStubArg %0
        isSmi left

      block LeftSmi -> RightSmi, RightNonSmi
        right = loadStubArg %1
        isSmi right

      block RightSmi -> Overflow, Success
        // both smis
        #if op === '+'
          r = smiAdd left, right
        #elif op === '-'
          r = smiSub left, right
        #elif op === '*'
          r = smiMul left, right
        #endif
        checkOverflow

      block Success
        ret r

      block LeftNonSmi -> RightNonSmi
      block RightNonSmi -> Overflow
      block Overflow
        // not smis
        brk
    */}, {
      locals: {
        op: op
      }
    });
  }, this);

  var ops = [ '<', '<=', '>', '>=', '==', '!=' ];
  ops.forEach(function(op) {
    this.declareStub('binary/' + op, function() {/*
      block BinaryLogic -> LeftSmi, LeftNonSmi
        left = loadStubArg %0
        isSmi left

      block LeftSmi -> RightSmi, RightNonSmi
        right = loadStubArg %1
        isSmi right

      block RightSmi -> True, False
        // both smis
        #if op === '<'
          smiCompare %"<", left, right
        #elif op === '<='
          smiCompare %"<=", left, right
        #elif op === '>'
          smiCompare %"<", right, left
        #elif op === '>='
          smiCompare %"<=", right, left
        #elif op === '=='
          smiCompare %"==", right, left
        #elif op === '!='
          smiCompare %"!=", right, left
        #endif

      block True
        r0 = literal %true
        ret r0

      block False
        r1 = literal %false
        ret r1

      block LeftNonSmi -> RightNonSmi
      block RightNonSmi
        // not smis
        brk
    */}, {
      locals: {
        op: op
      }
    });
  }, this);

  this.declareStub('binary/instanceof', function() {/*
    block BinaryInstanceOf -> Smi, NotSmi
      obj = loadStubArg %0
      fn = loadStubArg %1

      pushArg fn
      callStub %"stub", %"checkFunction", %1

      isSmi obj

    block Smi -> PreFalse

    block NotSmi -> Loop
      firstMap = readTagged obj, %{Base.offsets.map}
      to_phi objMap, firstMap

    block Loop -> Match, Next
      objMap = phi
      instanceMap = readTagged fn, %{Function.offsets.instanceMap}
      pointerCompare %"==", objMap, instanceMap

    block Next -> Continue, PreFalse
      proto = readTagged objMap, %{Map.offsets.proto}
      nextMap = readTagged proto, %{Base.offsets.map}
      pointerCompare %"!=", nextMap, objMap

    block Continue -> Loop
      to_phi objMap, nextMap

    block Match -> True

    block PreFalse -> False
    block False -> Join
      res0 = literal %false
      to_phi res, res0

    block True -> Join
      res1 = literal %true
      to_phi res, res1

    block Join
      res = phi
      ret res
  */}, {
    locals: {
      Base: Base,
      Map: Map,
      Function: Function
    }
  });
}
