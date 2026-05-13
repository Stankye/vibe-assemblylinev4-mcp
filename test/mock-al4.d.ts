export interface MockRequest {
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}
export interface MockServer {
    url: string;
    stop: () => Promise<void>;
    requests: MockRequest[];
    reset: () => void;
}
export declare function startMockServer(): Promise<MockServer>;
//# sourceMappingURL=mock-al4.d.ts.map