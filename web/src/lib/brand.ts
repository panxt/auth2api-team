import { useEffect, useState } from "react";
import { fetchBrand } from "../api/brand";

const DEFAULT_BRAND = "auth2api";

/**
 * Cosmetic display brand. Fetched once from the public `/brand` endpoint (works
 * pre-login) and applied to the document title. Falls back to "auth2api".
 */
export function useBrand(): string {
  const [brand, setBrand] = useState<string>(DEFAULT_BRAND);
  useEffect(() => {
    let alive = true;
    fetchBrand()
      .then((r) => {
        if (alive && r?.name) setBrand(r.name);
      })
      .catch(() => {
        /* keep default */
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    document.title = `${brand} · Admin`;
  }, [brand]);
  return brand;
}
