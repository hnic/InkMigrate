/**
 * JSON-RPC 2.0 协议定义（over stdio）。
 *
 * R12: RPC 类型已提取到 @inkmigrate/protocol 共享包，消除 GUI 侧重声明导致的
 * 类型漂移。本文件 re-export 共享类型，Engine 内部引用路径不变（向后兼容）。
 */

// R12: 所有 RPC params/result/notification/method-map 类型从共享包 re-export
export * from '@inkmigrate/protocol';

/** 所有消息的联合类型（stdout 输出）——Engine 传输层专用。 */
import type { RpcResponse, RpcNotification } from '@inkmigrate/protocol';
export type RpcMessage<T = unknown> = RpcResponse<T> | RpcNotification;
