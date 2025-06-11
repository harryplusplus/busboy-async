# Busboy Async

Busboy Async is an async generator-ized busboy.

## Why I Created This?

`busboy`([Github](https://github.com/mscdex/busboy)) is a library for parsing `multipart/form-data` requests in Node.js. Unlike other parsing libraries, it doesn't save to temporary files and then pass file paths or handles. Instead, it emits events with streams that are ready to be read directly. This approach has advantages: it avoids creating temporary files and doesn't load large amounts of data into memory all at once. Consequently, it eliminates the need for server access to the file system and doesn't require significant memory.

However, `busboy` is implemented by receiving a `NodeJS.ReadableStream` and emitting events via an `EventEmitter` interface. When file events are emitted, a `NodeJS.ReadableStream` interface is exposed, and library users must either process or resume this stream. If asynchronous functions are used within these event callbacks, the order of event processing isn't guaranteed. This can make business logic difficult to write and prone to errors. To address this, I created `busboy-async`.

Below is an example of using the original `busboy`. It reads files named `image` and `document`, uploads them to file storage, and updates the database. The order of each step is not guaranteed.

```js
const bb = busboy();
bb.on("file", (name, stream, info) => {
  if (name === "image") {
    uploadImage(stream, (error) => {
      if (error) {
        // Image upload failed.
      } else {
        updateDb((error) => {
          if (error) {
            // DB update failed.
            deleteImage();
          } else {
            // DB update successful.
          }
        });
      }
    });
  } else if (name === "document") {
    uploadDocument(stream)
      .then(() => {
        updateDb()
          .then(() => {
            // DB update successful.
          })
          .catch((error) => {
            // DB update failed.
            deleteDocument();
          });
      })
      .catch((error) => {
        // Document upload failed.
      });
  } else {
    stream.resume();
  }
});
```

Below is an example of using `busboy-async`.

```js
const bb = busboy();
try {
  for await (const event of bb) {
    const { type } = event;
    if (type === "file") {
      const { name, stream } = event;
      if (name === "image") {
        await uploadImage(stream);
        try {
          await updateDb();
        } catch (error) {
          await deleteImage();
          // Additionally, an exception can be thrown to prevent starting other file processing.
        }
      } else if (name === "document") {
        await uploadDocument(stream);
        try {
          await updateDb();
        } catch (error) {
          await deleteDocument();
          // Additionally, an exception can be thrown to prevent starting other file processing.
        }
      } else {
        stream.resume();
      }
    }
  }
} catch (error) {
  // Error handling
}
```

As shown above, because it's implemented using an `AsyncGenerator`, you can use the `for await` loop and guarantee the order of each processing step by using `await`. As in the example above, you can fully process one file at a time before moving on to the next.
