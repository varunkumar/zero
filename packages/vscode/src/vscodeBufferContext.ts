import { BufferContext, type CompletionRequest, type ContextChunk, type ContextProvider } from "@zero/core";

export interface DocumentLike { path: string; getText(): string }

export class VscodeBufferContext implements ContextProvider {
  name = "buffer";
  #getDocuments: () => DocumentLike[];

  constructor(getDocuments: () => DocumentLike[]) {
    this.#getDocuments = getDocuments;
  }

  async gather(req: CompletionRequest): Promise<ContextChunk[]> {
    const ctx = new BufferContext();
    ctx.setBuffers(this.#getDocuments().map((d) => ({ path: d.path, content: d.getText() })));
    return ctx.gather(req);
  }
}
