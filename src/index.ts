import busboyInternal, { BusboyConfig, BusboyEvents } from "busboy";
import { Queue } from "./queue";

type Source = NodeJS.ReadableStream & Pick<BusboyConfig, "headers">;
type Config = Omit<BusboyConfig, "headers">;

type FieldEvent = {
  type: "field";
  name: Parameters<BusboyEvents["field"]>[0];
  value: Parameters<BusboyEvents["field"]>[1];
  info: Parameters<BusboyEvents["field"]>[2];
};
type FieldsLimitEvent = {
  type: "fieldsLimit";
};
type FileEvent = {
  type: "file";
  name: Parameters<BusboyEvents["file"]>[0];
  stream: Parameters<BusboyEvents["file"]>[1];
  info: Parameters<BusboyEvents["file"]>[2];
};
type FilesLimitEvent = {
  type: "filesLimit";
};
type PartsLimitEvent = {
  type: "partsLimit";
};

type Event =
  | FieldEvent
  | FieldsLimitEvent
  | FileEvent
  | FilesLimitEvent
  | PartsLimitEvent;

type CloseInternalEvent = { type: "close" };
type ErrorInternalEvent = { type: "error"; error: unknown };

type InternalEvent = Event | CloseInternalEvent | ErrorInternalEvent;

export async function* busboy(source: Source, config?: Config) {
  const queue = new Queue<InternalEvent>();

  let resolver: (() => void) | null = null;
  let waiter: Promise<void> = new Promise((resolve) => (resolver = resolve));

  const notify = (event: InternalEvent) => {
    queue.push(event);

    if (resolver) {
      resolver();
      waiter = new Promise((resolve) => (resolver = resolve));
    }
  };

  const onClose: BusboyEvents["close"] = () => notify({ type: "close" });
  const onError: BusboyEvents["error"] = (error) =>
    notify({ type: "error", error });
  const onField: BusboyEvents["field"] = (name, value, info) =>
    notify({ type: "field", name, value, info });
  const onFieldsLimit: BusboyEvents["fieldsLimit"] = () =>
    notify({ type: "fieldsLimit" });
  const onFile: BusboyEvents["file"] = (name, stream, info) =>
    notify({ type: "file", name, stream, info });
  const onFilesLimit: BusboyEvents["filesLimit"] = () =>
    notify({ type: "filesLimit" });
  const onPartsLimit: BusboyEvents["partsLimit"] = () =>
    notify({ type: "partsLimit" });

  const busboy = busboyInternal({
    ...(config ?? {}),
    headers: source.headers,
  });

  try {
    busboy.on("close", onClose);
    busboy.on("error", onError);
    busboy.on("field", onField);
    busboy.on("fieldsLimit", onFieldsLimit);
    busboy.on("file", onFile);
    busboy.on("filesLimit", onFilesLimit);
    busboy.on("partsLimit", onPartsLimit);

    source.pipe(busboy);

    while (true) {
      if (!queue.isEmpty()) {
        const event = queue.pop();
        if (event.type === "close") {
          break;
        } else if (event.type === "error") {
          throw event.error;
        } else {
          yield event;
        }
      }

      await waiter;
    }
  } finally {
    source.unpipe(busboy);

    busboy.off("close", onClose);
    busboy.off("error", onError);
    busboy.off("field", onField);
    busboy.off("fieldsLimit", onFieldsLimit);
    busboy.off("file", onFile);
    busboy.off("filesLimit", onFilesLimit);
    busboy.off("partsLimit", onPartsLimit);

    busboy.destroy();
  }
}
