import { roundCoordinate } from "@/lib/location-privacy";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "CuidadoresApp/1.0";
const MIN_INTERVAL_MS = 1000;

export type GeocodeResult = {
  latitude: number;
  longitude: number;
};

// A política de uso do Nominatim limita as requisições a 1/segundo. As
// requisições são encadeadas por essa promise para que chamadas
// concorrentes do mesmo processo sejam serializadas com pelo menos
// MIN_INTERVAL_MS de intervalo entre elas.
let lastRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

function scheduleRequest<T>(run: () => Promise<T>): Promise<T> {
  const result = requestQueue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastRequestAt = Date.now();
    return run();
  });

  requestQueue = result.then(
    () => undefined,
    () => undefined
  );

  return result;
}

export function buildGeocodeQuery(
  parts: Array<string | null | undefined>
): string | null {
  const filtered = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  return filtered.length > 0 ? filtered.join(", ") : null;
}

export async function geocodeAddress(
  address: string
): Promise<GeocodeResult | null> {
  const query = address.trim();
  if (!query) return null;

  try {
    return await scheduleRequest(async () => {
      const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
      });

      if (!response.ok) return null;

      const results = (await response.json()) as Array<{
        lat: string;
        lon: string;
      }>;

      if (!results.length) return null;

      const latitude = Number(results[0].lat);
      const longitude = Number(results[0].lon);

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
      }

      // Só a localização aproximada é guardada -- ver lib/location-privacy.ts.
      return { latitude: roundCoordinate(latitude), longitude: roundCoordinate(longitude) };
    });
  } catch {
    return null;
  }
}
