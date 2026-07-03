import { get, put } from "./client";

/** Public (no-auth) brand name for login page + tab title. */
export const fetchBrand = () => get<{ name: string }>("/brand");

/** Admin: set the display brand (empty string reverts to default). */
export const updateBrand = (name: string) =>
  put<{ name: string }>("/admin/brand", { name });
