import { AccountStore, type WorkbenchState } from './accountStore';

type Persistence = { load: () => Promise<string | null>; save: (value: string) => Promise<void> };
/** Serialize durable transactions so concurrent page navigation cannot overwrite account edits. */
export class AccountRepository {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly persistence: Persistence) {}
  async read(): Promise<WorkbenchState> {
    await this.tail;
    const raw = await this.persistence.load();
    return new AccountStore({ getItem: () => raw, setItem: () => {} }).read();
  }
  change(operation: (store: AccountStore) => WorkbenchState): Promise<WorkbenchState> {
    const result = this.tail.then(async () => {
      let raw = await this.persistence.load();
      const store = new AccountStore({
        getItem: () => raw,
        setItem: (_key, value) => {
          raw = value;
        },
      });
      const next = operation(store);
      await this.persistence.save(JSON.stringify(next));
      return next;
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
