import type { Vault } from "../crypto/vault";
import type { BoardDb } from "./db";

/** What every store function needs: the database and the vault that protects free-text columns. */
export interface Store {
  db: BoardDb;
  vault: Vault;
}
