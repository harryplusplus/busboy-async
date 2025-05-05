export class Queue<TItem = unknown> {
  private data = new Map<number, TItem>();
  private head = 0;
  private tail = 0;

  isEmpty() {
    return this.head === this.tail;
  }

  push(item: TItem) {
    this.data.set(this.tail, item);
    this.tail = this.advance(this.tail);
  }

  pop(): TItem {
    const result = this.data.get(this.head);
    this.data.delete(this.head);
    this.head = this.advance(this.head);

    return result!;
  }

  private advance(value: number) {
    if (value === Number.MAX_SAFE_INTEGER) {
      return 0;
    } else {
      return value + 1;
    }
  }
}
