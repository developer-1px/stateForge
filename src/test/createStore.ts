import {createPathProxy, getValueFromPath, ReflectGet, ReflectSet} from "./createPathProxy.ts"
import {useEffect, useMemo, useRef, useState} from "react"

const isObject = (obj: unknown): obj is object => Object(obj) === obj

const isPrimitive = (value: unknown): value is boolean | number | string | symbol => Object(value) !== value

const valueOf = <T>(value: T) => (typeof value?.valueOf === "function" ? value.valueOf() : value)

const makePathString = (path: string[], prop: string) => [...path, prop].join(".")

const traverseObject = <T extends object>(
  obj: T,
  callback: (path: string[], prop: string, value: unknown) => void | false,
  path: string[] = []
) => {
  if (!isObject(obj)) {
    return
  }

  Object.entries(obj).forEach(([key, value]) => {
    const currentPath = [...path, key]
    const res = callback(path, key, value)
    if (res !== false && isObject(value)) {
      traverseObject(value, callback, currentPath)
    }
  })
}

const safeReflectGet = <T>(target: object, path: string[], prop: string): T | undefined => {
  const current = getValueFromPath(target, path)
  return ReflectGet(current, prop)
}

const safeReflectSet = (target: object, path: string[], prop: string, valueFn: (exist: unknown) => unknown) => {
  path.forEach((p) => {
    let next = ReflectGet(target, p)
    if (!next) {
      next = {}
      ReflectSet(target, p, next)
    }
    target = next
  })
  return ReflectSet(target, prop, valueFn(ReflectGet(target, prop)))
}

//
//
// --- StoreProxy

const createStoreProxy = <T extends object>($store: T, $state: T): T => {
  const store = createPathProxy($store, () => {
    const get = (path) => (_, prop) => safeReflectGet($store, path, prop) ?? {}

    const set = (path) => (_, prop, value) => {
      const result = safeReflectSet($store, path, prop, () => value)

      // @TODO: @fixme!! 리듀서에게 위임하기?
      if (value instanceof Reducer) {
        if (value.computed) {
          return result
        }
        value = value.initValue
      }

      // @TODO: 아래 코드 설명 필요!
      safeReflectSet($state, path, prop, (exist) => (exist === undefined ? value : exist))
      return result
    }

    return {get, set}
  }) as T

  return store
}

const getComputedValueFromStore = ($store: object, path: string[], prop: string) => {
  const storeValue = safeReflectGet($store, path, prop)
  if (storeValue instanceof Reducer) {
    if (storeValue.computed) {
      return [true, storeValue.computed.getValue()] as const
    }
  }
  return [false, undefined] as const
}

//
//
/// --- StateProxy

type SubscribeCallback = (...args: unknown[]) => void
const stateMutations = new Set<SubscribeCallback>()

globalThis.stateMutations = stateMutations

const subscribeStateMutation = (callback: SubscribeCallback) => {
  stateMutations.add(callback)
  return () => stateMutations.delete(callback)
}

const publishStateMutation = (...args: unknown[]) => {
  stateMutations.forEach((callback) => callback(...args))
}

const createStateProxy = <State extends object>($store: State, $state: State, name: string = "") => {
  const deps = new Set<string>()
  const version = {value: 0}

  const state = createPathProxy($state, () => {
    // State에서 값 가져오기 규칙
    const get = (path: string[]) => (_, prop) => {
      // 1. Store값(=Reducer)가 있다면 우선한다.
      const [hasStoreValue, storeValue] = getComputedValueFromStore($store, path, prop)
      if (hasStoreValue) {
        return storeValue
      }

      // 2. 변화추적을 위해 사용되고 있는 path 기록
      const pathString = makePathString(path, prop)
      deps.add(pathString)

      // 3. State의 값 반환
      const value = safeReflectGet($state, path, prop)

      // @TODO: Array라면???

      // push, pop,

      return value
    }

    // State에서 보관하기
    const set = (path: string[]) => (_, prop, value) => {
      const current = getValueFromPath($state, path)
      const existValue = ReflectGet(current, prop)

      // 값은 값이라면 업데이트 하지 않는다.
      if (existValue === value) {
        return true
      }

      // 값 저장 이후 변경사항 전파
      if (ReflectSet(current, prop, value)) {
        publishStateMutation($state, path, prop, value, existValue, name)
        return true
      }

      return false
    }

    return {get, set}
  }) as State

  return [state, deps] as const
}

//
//
// --- Draft

const cloneOf = (value: unknown) => {
  if (Array.isArray(value)) return [...value]
  if (isObject(value)) return {...value}
  return value
}

export const createDraftProxy = <State extends object>($store: State, $state: State) => {
  const $draft_store: State = {} as State
  const $draft_cache: State = {} as State

  let $draft: State = {} as State

  const draft = createPathProxy($draft, () => {
    const get = (path) => (_, prop) => {
      // 내가 작성하고 있는 값 우선
      let value = safeReflectGet($draft, path, prop)
      if (value !== undefined) {
        return value
      }

      // 초기 state 값
      value = safeReflectGet($draft_cache, path, prop)
      if (value !== undefined) {
        return value
      }

      // Draft는 원본값을 복사해서 가져온다.
      value = safeReflectGet($state, path, prop)
      if (value !== undefined) {
        value = cloneOf(value)
        safeReflectSet($draft_cache, path, prop, () => value)
        return value
      }

      // @FIXME
      let reducer = safeReflectGet($draft_store, path, prop)
      if (reducer instanceof Reducer && reducer.computed) {
        return reducer.computed.getValue()
      }

      // @FIXME
      reducer = safeReflectGet($store, path, prop)
      if (reducer instanceof Reducer) {
        const newReducer = reducer.clone($draft_store)
        safeReflectSet($draft_store, path, prop, () => newReducer)

        if (newReducer.computed) {
          return newReducer.computed.getValue()
        }

        value = cloneOf(newReducer.initValue)
        safeReflectSet($draft_cache, path, prop, () => value)
      } else if (reducer !== undefined) {
        value = cloneOf(reducer)
        safeReflectSet($draft_cache, path, prop, () => value)
      }

      return value
    }

    const set = (path) => (_, prop, value) => {
      // Computed Reducer값을 넣을 수 없다.
      const reducer = safeReflectGet($draft_store, path, prop) ?? safeReflectGet($store, path, prop)
      if (reducer instanceof Reducer && reducer.computed) {
        throw new TypeError("Cannot reassign a value to a computed property in the draft state")
        return false
      }

      return safeReflectSet($draft, path, prop, () => value)
    }

    return {get, set}
  }) as State

  // 불변성을 유지하기 위해서 새로운 값이 바뀌면 draft는 이전 값을 유지한다.
  const unsubscribe = subscribeStateMutation((target, path, prop, _value, existValue) => {
    if ($state !== target) {
      return
    }

    const draftValue = safeReflectGet($draft, path, prop)
    if (draftValue === undefined) {
      safeReflectSet($draft_cache, path, prop, () => existValue)
    }
  })

  const commit = () => {
    const [state] = createStateProxy($store, $state, "commit")

    traverseObject($draft, (path, prop, value) => {
      if (isPrimitive(value)) {
        safeReflectSet(state, path, prop, () => value)
        safeReflectSet($draft_cache, path, prop, () => value)
        return false
      }
    })

    $draft = {} as State
  }

  return {draft, commit, unsubscribe}
}

// Computed
type Computed<T> = {
  getValue: () => T | undefined
  unsubscribe: () => void
}

const createComputed = <State extends object, T>($store: State, $state: State, computedFn: (state: State) => T): Computed<T> => {
  let value: T | undefined = undefined
  let version = 0
  let lastVersion = -1

  const [state, deps] = createStateProxy($store, $state, "computed")

  // 변경사항이 생기면 version을 올린다.
  const unsubscribe = subscribeStateMutation((target, path, prop) => {
    // @FIXME: 이거 없애는 법을 고민해보자!
    if ($state !== target) {
      return
    }

    // version up!
    const pathString = makePathString(path, prop)
    if (deps.has(pathString)) {
      version++
    }
  })

  const getValue = (): T | undefined => {
    if (lastVersion !== version) {
      value = computedFn(state)
      lastVersion = version
    }
    return value
  }

  return {getValue, unsubscribe}
}

// Reducer
type Init<State, T> = ((state: State) => T) | T
type On<Actions, State> = {
  [K in keyof Actions]: (fn: (...args: Actions[K] extends (...args: infer P) => unknown ? P : never[]) => (state: State) => void) => void
}
type EffectFn = () => void
type ReducerFn<State, Actions> = (on: On<Actions, State>, effect: EffectFn) => void

class Reducer<State extends object, Actions, T> {
  public initValue: T | undefined
  public computed: Computed<T> | undefined

  constructor(
    public init: Init<State, T>,
    public reducerFn: ReducerFn<State, Actions>,
    public $store: State,
    public $state: State
  ) {
    this.initValue = typeof init !== "function" ? init : undefined
    this.computed = typeof init === "function" ? createComputed($store, $state, init) : undefined
  }

  clone($store: State) {
    return new Reducer<State, Actions, T>(this.init, this.reducerFn, $store, this.$state)
  }
}

//
//
// --- Store
export const createStore = <State extends object, Actions>() => {
  const $store = {} as State
  const $state = {} as State

  const store = createStoreProxy($store, $state)

  const noop = () => {}

  const reducer = <T, R extends T>(init: Init<State, T>, fn: ReducerFn<State, Actions> = noop): R =>
    new Reducer(init, fn, $store, $state) as R

  const createState = (name: string) => createStateProxy($store, $state, name)

  // createDispatch
  const $dispatch = (type: string, args: unknown[]) => {
    const {draft, commit, unsubscribe} = createDraftProxy($store, $state)

    const on = new Proxy(Function, {
      get: (_, actionType: string) => (fn: Function) => {
        if (actionType === type) {
          // @TODO: fn이 function이 아니라 값이라면 바로 값을 넣어 줄 수 있다.
          if (typeof fn !== "function") {
            // @TODO: drfat[prop] = fn
            // @TODO: 그럴려면 prop이름을 store.reducer에서 알 수 있어야 한다.
          }

          // @TODO: state에 뭔가를 추적을 할 수 있는 것들을 넣으면 좋겠는데...
          const result = fn(...args)(draft)

          // @TODO: reuslt 비동기처리
        }
      },
      apply(_, thisArg, argumentsList) {
        //TODO

        console.log(argumentsList)
      },
    }) as On<Actions, State>

    // reduce 실행
    traverseObject(store, (path, prop, value) => {
      const reducer = value
      if (reducer instanceof Reducer) {
        reducer.reducerFn(on)
        return false
      }
    })

    commit()

    // @TODO: 비동기 unsubscribe를 고려해야됨.
    unsubscribe()
  }

  const dispatch = new Proxy(Function, {
    get:
      (_, type: string) =>
      (...payload: unknown[]) => {
        // console.group(type + "(", ...payload, ")")
        // console.groupCollapsed("(callstack)")
        // console.trace("")
        // console.groupEnd()
        console.log("[dispatch]", type, ...payload)
        $dispatch(type, payload)
        // console.groupEnd()
      },
  }) as Actions

  //
  //
  // --- React
  const useStore = (name: string) => {
    const [state, deps] = createState(name)
    const [version, setVersionsion] = useState(0)
    const isUnsubscribed = useRef(false)

    const unsubscribe = subscribeStateMutation((target, path, prop) => {
      if (state.valueOf() !== target) return

      const pathString = makePathString(path, prop)
      if (deps.has(pathString)) {
        unsubscribe()
        isUnsubscribed.current = true
        setVersionsion(version + 1)
      }
    })

    useEffect(() => {
      return () => {
        if (!isUnsubscribed) {
          isUnsubscribed.current = false
          unsubscribe()
        }
      }
    }, [unsubscribe])

    state.dispatch = dispatch
    return state as State & {dispatch: Actions}
  }

  return {store, reducer, createState, dispatch, useStore, $store, $state}
}
