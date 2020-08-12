import { createReadStream, promises as fs } from 'fs'
import ndjson from 'ndjson'
import sleep from 'sleep-promise'
import { throttle } from 'throttle-debounce'

type Indexed<T> = T & { index: number }

export type EventListener<E> = (event: Indexed<E>) => Promise<void>

export interface StateStore<S> {
  getState: () => S
  getVersion: () => number
  update: (newState: S, newVersion: number) => void
}

export interface StateSnapshot<S> {
  _version: number
  state: S
}

export interface Log<DomainEvent> {
  events: () => AsyncIterable<Indexed<DomainEvent>>
  append: (event: DomainEvent) => Promise<void>
}

interface StateStoreBackend<S> {
  name: string
  read: () => Promise<StateSnapshot<S> | null>
  write: (stateSnapshot: StateSnapshot<S>) => Promise<void>
}

const readLog = <DomainEvent>(filename: string): Promise<DomainEvent[]> => {
  return new Promise((resolve, reject) => {
    const log: DomainEvent[] = []
    createReadStream(filename)
      .on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          resolve([])
        } else {
          reject(err)
        }
      })
      .pipe(ndjson.parse())
      .on('data', (item) => {
        log.push(item)
      })
      .on('end', () => {
        resolve(log)
      })
  })
}

export const catchupSubscribe = async <E>(
  events: AsyncIterable<Indexed<E>>,
  subscriber: (event: Indexed<E>) => Promise<void>,
): Promise<void> => {
  for await (const event of events) {
    await subscriber(event)
  }
}

export const initLog = async <DomainEvent>({
  fsImpl = fs,
  filename,
}: {
  filename: string
  fsImpl?: Pick<typeof fs, 'readFile' | 'appendFile'>
}): Promise<Log<DomainEvent>> => {
  const entries: Indexed<DomainEvent>[] = await readLog(filename)

  const events = (): AsyncIterable<Indexed<DomainEvent>> => ({
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          if (i < entries.length) {
            const value = entries[i++]
            return { done: false, value }
          } else {
            await sleep(1000)
            return this.next()
          }
        },
      }
    },
  })

  const append = async (event: DomainEvent) => {
    const indexedEvent = {
      ...event,
      index: entries.length,
    }

    entries.push(indexedEvent)

    await fsImpl.appendFile(
      filename,
      JSON.stringify(indexedEvent) + '\n',
      'utf8',
    )
  }

  return { events, append }
}

export const fsStoreBackend = <S>(filename: string): StateStoreBackend<S> => {
  const name = filename

  const read = async (): Promise<StateSnapshot<S> | null> => {
    try {
      return JSON.parse(await fs.readFile(filename, 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null
      } else {
        throw err
      }
    }
  }

  const write = throttle(
    1000,
    (stateSnapshot: StateSnapshot<S>) => {
      return fs.writeFile(
        filename,
        JSON.stringify(stateSnapshot, null, 2),
        'utf8',
      )
    },
    false,
  )

  return { name, read, write }
}

export const initStateStore = async <S>({
  storeBackend,
  initialState,
}: {
  storeBackend: StateStoreBackend<S>
  initialState: S
}): Promise<StateStore<S>> => {
  const stateSnapshot: StateSnapshot<S> = (await storeBackend.read()) || {
    _version: -1,
    state: initialState,
  }

  const getState = () => stateSnapshot.state
  const update = (newState: S, newVersion: number) => {
    if (!stateSnapshot) {
      throw new Error(
        'Cannot update state that has not been initialized [${stateFile}]',
      )
    }

    if (newVersion <= stateSnapshot._version) {
      throw new Error(
        `[${storeBackend.name}] ` +
          `Proposed state version (${newVersion}) is not higher than old state version (${stateSnapshot._version})`,
      )
    }

    stateSnapshot._version = newVersion
    stateSnapshot.state = newState
    console.log(`[${storeBackend.name}] State updated to version ${newVersion}`)

    storeBackend.write(stateSnapshot)
  }

  const getVersion = () => {
    return stateSnapshot._version
  }

  return { getState, update, getVersion }
}
