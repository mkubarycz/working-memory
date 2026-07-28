/**
 * Trimmed ambient declaration for the proposed `chatSessionsProvider` VS Code
 * API. PROTOTYPE ONLY.
 *
 * This declares just the subset of the proposal that `src/chatSession/` uses.
 * The real runtime surface is richer (input-state, options groups, fork/resolve
 * handlers, etc.); these shapes are deliberately kept runtime-compatible so the
 * prototype type-checks without pulling in the full web of interdependent chat
 * proposals (`ChatRequestTurn2`, `ChatSessionInputState`, …).
 *
 * Verified against the locally installed VS Code build: the public
 * `vscode.chat.*` signatures below match the extension-host wrappers exactly.
 *
 * To run: launch an Extension Development Host with
 *   --enable-proposed-api kubarycz.working-memory
 * and keep `"enabledApiProposals": ["chatSessionsProvider"]` in package.json.
 */

declare module 'vscode' {
  /** Lifecycle status of a chat session, shown in the sessions UI. */
  export enum ChatSessionStatus {
    Failed = 0,
    Completed = 1,
    InProgress = 2,
    NeedsInput = 3,
  }

  /** A chat session surfaced in the sessions list / handoff picker. */
  export interface ChatSessionItem {
    readonly resource: Uri;
    label: string;
    iconPath?: IconPath;
    description?: string | MarkdownString;
    tooltip?: string | MarkdownString;
    status?: ChatSessionStatus;
  }

  /** Managed collection of {@link ChatSessionItem}s owned by a controller. */
  export interface ChatSessionItemCollection {
    readonly size: number;
    replace(items: readonly ChatSessionItem[]): void;
    add(item: ChatSessionItem): void;
    delete(resource: Uri): void;
    get(resource: Uri): ChatSessionItem | undefined;
  }

  export type ChatSessionItemControllerRefreshHandler = (
    token: CancellationToken,
  ) => Thenable<void>;

  /** A selectable item inside an option group (e.g. one workstream). */
  export interface ChatSessionProviderOptionItem {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly icon?: ThemeIcon;
    readonly default?: boolean;
    readonly locked?: boolean;
    readonly tooltip?: string;
  }

  /** A group of related options rendered as a picker at the chat input. */
  export interface ChatSessionProviderOptionGroup {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly selected?: ChatSessionProviderOptionItem;
    readonly items: readonly ChatSessionProviderOptionItem[];
    readonly icon?: ThemeIcon;
    readonly when?: string;
  }

  /** Live, mutable input state for one chat session (drives the bottom pills). */
  export interface ChatSessionInputState {
    readonly onDidChange: Event<void>;
    readonly onDidDispose: Event<void>;
    readonly sessionResource: Uri | undefined;
    /** Replace the whole array to update the rendered option pickers. */
    groups: readonly ChatSessionProviderOptionGroup[];
  }

  export type ChatSessionControllerGetInputState = (
    sessionResource: Uri | undefined,
    context: { readonly previousInputState: ChatSessionInputState | undefined },
    token: CancellationToken,
  ) => Thenable<ChatSessionInputState> | ChatSessionInputState;

  /** Context passed when the user starts a brand-new session for this type. */
  export interface ChatSessionNewItemContext {
    readonly request: {
      readonly prompt: string;
      readonly command?: string;
    };
  }

  /** Owns the list of chat sessions for a single session type. */
  export interface ChatSessionItemController {
    readonly id: string;
    readonly items: ChatSessionItemCollection;
    createChatSessionItem(resource: Uri, label: string): ChatSessionItem;
    newChatSessionItemHandler?: (
      context: ChatSessionNewItemContext,
      token: CancellationToken,
    ) => Thenable<ChatSessionItem>;
    getChatSessionInputState?: ChatSessionControllerGetInputState;
    createChatSessionInputState(
      groups: readonly ChatSessionProviderOptionGroup[],
    ): ChatSessionInputState;
    dispose(): void;
  }

  export interface ChatSessionCapabilities {
    supportsInterruptions?: boolean;
  }

  /** The content (history + request handler) backing one open chat session. */
  export interface ChatSession {
    readonly title?: string;
    readonly history: ReadonlyArray<ChatRequestTurn | ChatResponseTurn>;
    readonly activeResponseCallback?: (
      stream: ChatResponseStream,
      token: CancellationToken,
    ) => Thenable<void>;
    readonly requestHandler: ChatRequestHandler | undefined;
  }

  export interface ChatSessionContentProvider {
    provideChatSessionContent(
      resource: Uri,
      token: CancellationToken,
      context: { readonly inputState: ChatSessionInputState },
    ): Thenable<ChatSession> | ChatSession;
  }

  export namespace chat {
    export function createChatSessionItemController(
      chatSessionType: string,
      refreshHandler: ChatSessionItemControllerRefreshHandler,
    ): ChatSessionItemController;

    export function registerChatSessionContentProvider(
      scheme: string,
      provider: ChatSessionContentProvider,
      defaultChatParticipant: ChatParticipant,
      capabilities?: ChatSessionCapabilities,
    ): Disposable;
  }
}
