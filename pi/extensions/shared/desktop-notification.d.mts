export type DesktopNotification = { id: string; kind: "input" | "completion" | "error"; title: string; body: string };
export type DesktopDelivery = Omit<DesktopNotification, "id"> & { onError?: (error: Error) => void };
export const DESKTOP_NOTIFICATION_STATUS: "pi-console-desktop-notification";
export function validDesktopNotification(value: unknown): value is DesktopNotification;
export function deliverDesktopNotification(options: DesktopDelivery): boolean;
