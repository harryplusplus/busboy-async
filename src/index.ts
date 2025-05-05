import busboyInternal, { BusboyConfig, BusboyEvents } from "busboy";
import { Queue } from "./queue";

type Source = NodeJS.ReadableStream & Pick<BusboyConfig, "headers">;
type Config = Omit<BusboyConfig, "headers">;

type FieldEvent = {
  event: "field";
  name: Parameters<BusboyEvents["field"]>[0];
  value: Parameters<BusboyEvents["field"]>[1];
  info: Parameters<BusboyEvents["field"]>[2];
};
type FieldsLimitEvent = {
  event: "fieldsLimit";
};
type FileEvent = {
  event: "file";
  name: Parameters<BusboyEvents["file"]>[0];
  stream: Parameters<BusboyEvents["file"]>[1];
  info: Parameters<BusboyEvents["file"]>[2];
};
type FilesLimitEvent = {
  event: "filesLimit";
};
type PartsLimitEvent = {
  event: "partsLimit";
};

type Event =
  | FieldEvent
  | FieldsLimitEvent
  | FileEvent
  | FilesLimitEvent
  | PartsLimitEvent;

type CloseInternalEvent = { event: "close" };
type ErrorInternalEvent = { event: "error"; error: unknown };

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

  const onClose: BusboyEvents["close"] = () => notify({ event: "close" });
  const onError: BusboyEvents["error"] = (error) =>
    notify({ event: "error", error });
  const onField: BusboyEvents["field"] = (name, value, info) =>
    notify({ event: "field", name, value, info });
  const onFieldsLimit: BusboyEvents["fieldsLimit"] = () =>
    notify({ event: "fieldsLimit" });
  const onFile: BusboyEvents["file"] = (name, stream, info) =>
    notify({ event: "file", name, stream, info });
  const onFilesLimit: BusboyEvents["filesLimit"] = () =>
    notify({ event: "filesLimit" });
  const onPartsLimit: BusboyEvents["partsLimit"] = () =>
    notify({ event: "partsLimit" });

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
        if (event.event === "close") {
          break;
        } else if (event.event === "error") {
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
