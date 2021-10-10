import { Field } from "./field";
import { poseidon } from "./poseidon";
import {
  default_snapshot_id,
  local_uri,
  MerkleTreeDb
} from "./db";
import { Cache } from "./cache";
import BN from "bn.js";

const hash = poseidon;
export const MaxHeight = 16;
export const BlockShift = 2;
export const BlockSize = 1 << BlockShift;

export interface PathInfo {
  root: Field;
  index: number;
  pathDigests: Field[][];
}

export class MarkleTree {
  private currentSnapshotIdx: string | undefined = undefined;
  private cache = new Cache(10000);
  private db_name = "delphinus";
  private db = new MerkleTreeDb(local_uri, this.db_name);

  static emptyHashes: Field[] = [];
  static emptyNodeHash(height: number) {
    if (this.emptyHashes.length === 0) {
      this.emptyHashes.push(new Field(0));
      for (let i = 0; i < MaxHeight; i++) {
        const last = this.emptyHashes[i];
        this.emptyHashes.push(hash([last, last, last, last]));
      }
      this.emptyHashes = this.emptyHashes.reverse();
    }
    return this.emptyHashes[height];
  }

  private async getRawNode(mtIndex: string) {
    return await this.db.queryMerkleTreeNodeFromPath(mtIndex + "I");
  }

  async getNode(mtIndex: string) {
    if (mtIndex.startsWith("-")) {
      throw new Error(mtIndex);
    }
    let field = this.cache.find(mtIndex);
    if (field !== undefined) {
      return field;
    } else {
      let node = await this.getRawNode(mtIndex);
      return node === undefined ? undefined : node.field;
    }
  }

  async setNode(mtIndex: string, value: Field) {
    if (this.currentSnapshotIdx === undefined) {
      throw new Error("snapshot not set");
    } else {
      let oldDoc = (await this.getRawNode(mtIndex)) || undefined;
      await this.db.updatePathLogging(
        mtIndex + "I",
        oldDoc?.field !== undefined
          ? oldDoc.field
          : MarkleTree.emptyNodeHash(mtIndex.length),
        value,
        oldDoc?.snapshot ?? default_snapshot_id,
        this.currentSnapshotIdx
      );
    }

    this.cache.add(mtIndex, value);
  }

  async startSnapshot(id: string) {
    this.currentSnapshotIdx = id;
  }

  async endSnapshot() {
    this.db.updateLatestSnapshotId(this.currentSnapshotIdx!);
    this.currentSnapshotIdx = undefined;
  }

  async lastestSnapshot() {
    return this.db.queryLatestSnapshotId();
  }

  async loadSnapshot(latest_snapshot: string) {
    await this.db.restoreMerkleTree(latest_snapshot);
    this.cache.invalidate();
  }

  async closeDb() {
    await this.db.closeMongoClient();
  }

  private async getNodeOrDefault(mtIndex: string) {
    let value = await this.getNode(mtIndex);
    if (value === undefined) {
      value = MarkleTree.emptyNodeHash(mtIndex.length);
    }
    return value;
  }

  private async getNodeOrCreate(mtIndex: string) {
    let value = await this.getNode(mtIndex);
    if (value === undefined) {
      value = MarkleTree.emptyNodeHash(mtIndex.length);
      await this.setNode(mtIndex, value);
    }
    return value;
  }

  private convertToMtIndex(index: number) {
    // toString() may get negative value
    let ret = "";
    for (let i = 0; i < MaxHeight; i++) {
      ret = ((index >> (i * 2)) & 3).toString() + ret;
    }
    return ret;
  }

  private async fillPath(index: number) {
    const mtIndex = this.convertToMtIndex(index);
    for (let i = 0; i < MaxHeight; i++) {
      await this.getNodeOrCreate(mtIndex.slice(0, i));
    }
  }

  async getPath(index: number) {
    const ret = {
      root: await this.getNodeOrDefault(""),
      index: index,
      pathDigests: [] as Field[][],
    } as PathInfo;

    const mtIndex = this.convertToMtIndex(index);
    for (let i = 0; i < MaxHeight; i++) {
      const digests = await Promise.all(
        // Used to generate [0, 1, ..., BlockSize]
        Array.from(Array(BlockSize).keys()).map((v) =>
          this.getNodeOrDefault(mtIndex.slice(0, i) + v)
        )
      );
      ret.pathDigests.push(digests);
    }

    return ret;
  }

  async getLeave(index: number) {
    const mtIndex = this.convertToMtIndex(index);
    return await this.getNodeOrDefault(mtIndex);
  }

  private async getChildren(mtIndex: string) {
    return await Promise.all(
      Array.from(Array(BlockSize).keys()).map((v) =>
        this.getNodeOrDefault(mtIndex + v)
      )
    );
  }

  async getLeaves(index: number) {
    const mtIndex = this.convertToMtIndex(index);
    return this.getChildren(mtIndex.slice(0, MaxHeight - 1));
  }

  private async updateHash(index: number) {
    const mtIndex = this.convertToMtIndex(index);
    for (let i = 0; i < MaxHeight; i++) {
      const layer = MaxHeight - i - 1;
      const layerIndex = mtIndex.slice(0, layer);
      const children = await this.getChildren(layerIndex);
      const value = hash(children);
      await this.setNode(layerIndex, value);
    }
  }

  async getRoot() {
    return this.getNodeOrDefault("");
  }

  async setLeave(index: number, value: Field) {
    const mtIndex = this.convertToMtIndex(index);
    const path = await this.fillPath(index);
    await this.setNode(mtIndex, value);
    await this.updateHash(index);
    return path;
  }

  async setLeaves(index: number, values: Field[]) {
    if (values.length != BlockSize) {
      throw new Error(`Invalid leaves length: ${values.length}`);
    }

    const mtIndex = this.convertToMtIndex(index);
    const path = await this.fillPath(index);

    await Promise.all(
      // Used to generate [0, 1, ..., BlockSize]
      Array.from(Array(BlockSize).keys()).map((v) =>
        this.setNode(mtIndex.slice(0, MaxHeight - 1) + v, values[v])
      )
    );
    await this.updateHash(index);
    return path;
  }
}
