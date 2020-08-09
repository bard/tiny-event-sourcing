import { createReadStream, promises as fs } from 'fs'
import ndjson from 'ndjson'
import sleep from 'sleep-promise'
import { throttle } from 'throttle-debounce'

export type Indexed<T> = T & { index: number }

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

const filePersister = <S>(filename: string) => (
  state: StateSnapshot<S>,
): Promise<void> => {
  return fs.writeFile(filename, JSON.stringify(state, null, 2), 'utf8')
}

const fileHydrater = <S>(filename: string, emptyState: S) => async (): Promise<
  StateSnapshot<S>
> => {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { _version: -1, state: emptyState }
    } else {
      throw err
    }
  }
}

export const createStateStore = async <S>({
  filename,
  emptyState,
}: {
  filename: string
  emptyState: S
}): Promise<StateStore<S>> => {
  const hydrate = fileHydrater(filename, emptyState)
  const persist = filePersister(filename)

  const throttledSave = throttle(1000, persist, false)
  const stateSnapshot: StateSnapshot<S> = await hydrate()

  const getState = () => stateSnapshot.state
  const update = (newState: S, newVersion: number) => {
    if (!stateSnapshot) {
      throw new Error(
        'Cannot update state that has not been initialized [${stateFile}]',
      )
    }

    if (newVersion <= stateSnapshot._version) {
      throw new Error(
        `Proposed state version (${newVersion}) is not higher than old state version (${stateSnapshot._version}) [${filename}]`,
      )
    }

    stateSnapshot.state = newState
    console.log(`State updated to version ${newVersion} [${filename}]`)

    throttledSave(stateSnapshot)
  }

  const getVersion = () => {
    return stateSnapshot._version
  }

  return { getState, update, getVersion }
}
