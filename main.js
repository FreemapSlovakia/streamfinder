import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import turfArea from "@turf/area";
import { $ } from "zx";

// Reading the SRS of some GeoTIFFs (EPSG:8353, S-JTSK [JTSK03]) fails unless
// GDAL trusts the EPSG registry over the embedded GeoTIFF keys.
process.env.GTIFF_SRS_SOURCE ??= "EPSG";

/**
 * @typedef {{
 *   dir: string,
 *   path: string,
 *   attributions: { name: string, url?: string }[],
 *   osmSource?: string,
 *   wkt: string,
 *   bbox: [number, number, number, number],
 * }} Source
 */

/**
 * The running request. `run` refuses to go on once it is aborted, so a late
 * "close" of an earlier request can only abort its own job.
 *
 * @type {{ aborted: boolean, p?: import("zx").ProcessPromise }}
 */
let job = { aborted: false };

const sources = await loadSources(process.env.ELEVATION_DIR);

if (!sources.length) {
  console.error("No elevation sources; set ELEVATION_DIR.");

  process.exit(1);
}

let busy = false;

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

const server = http.createServer(handleRequest);

/**
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns
 */
async function handleRequest(req, res) {
  if (
    req.method === "POST" &&
    req.headers["content-type"] !== "application/json"
  ) {
    res.writeHead(406, { "Content-Type": "text/plain" });
    res.end("Body is not application/json.");
    return;
  }

  if (busy) {
    console.log("[Busy]");
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Busy, try again later.");
    return;
  }

  console.log("[Starting]");

  let closed = false;

  const thisJob = { aborted: false };

  res.on("close", () => {
    console.log("[Closed]");

    closed = true;

    thisJob.aborted = true;

    thisJob.p?.kill("SIGTERM").catch((err) =>
      console.error("Error terminating process", err)
    );
  });

  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;

  const threshold = params.get("threshold") || "20000";

  const pixelSize = params.get("pixel-size");

  const minLen = params.get("min-len") || "50";

  const simplifyTolerance = params.get("simplify-tolerance") || "1.5";

  if (
    [threshold, pixelSize ?? "1", minLen, simplifyTolerance].some((a) =>
      isNaN(parseFloat(a))
    )
  ) {
    res.statusCode = 400;
    return;
  }

  const toOsm = /^(1|true|yes)$/.test(params.get("to-osm"));

  busy = true;

  job = thisJob;

  const isHead = req.method === "HEAD";

  // Whitespace may lead a JSON document, and an XML one after its
  // declaration, so the keep-alive sends the declaration with the header.
  const preamble = toOsm ? XML_DECLARATION : "";

  function writeHeader() {
    if (res.headersSent) {
      return;
    }

    res.writeHead(200, {
      "Content-Type": toOsm ? "application/xml" : "application/geo+json",
      "Content-Disposition": `attachment; filename="streams.${
        toOsm ? "osm" : "geojson"
      }"`,
    });

    if (!isHead) {
      res.write(preamble);
    }
  }

  try {
    const ws = fs.createWriteStream("mask.geojson");

    if (req.method === "POST") {
      await new Promise((resolve, reject) => {
        ws.on("open", () => {
          req.pipe(ws);
        });

        ws.on("error", (err) => {
          reject(err);
        });

        req.on("error", (err) => {
          reject(err);
        });

        req.on("end", () => {
          resolve();
        });
      });
    } else if (req.method === "GET" || isHead) {
      const mask = params.get("mask");

      if (!mask) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(isHead ? "" : "Missing mask parameter.");
        return;
      }

      await new Promise((resolve, reject) => {
        ws.write(mask, (err) => {
          if (err) {
            reject(err);
          } else {
            ws.close((err) => {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          }
        });
      });
    } else {
      res.writeHead(405);
      res.end();
      return;
    }

    console.log("[Responding]");

    let tid;

    if (!isHead) {
      // JOSM reads with a 30 s timeout
      tid = setInterval(() => {
        if (res.headersSent) {
          res.write("\n");
        } else {
          writeHeader();
        }
      }, 10000);
    }

    try {
      await workHard(threshold, minLen, simplifyTolerance, pixelSize, toOsm);
    } finally {
      clearInterval(tid);
    }

    const filename = toOsm ? "result.osm" : "result.geojson";

    if (isHead) {
      const stat = await fs.promises.stat(filename);

      res.setHeader(
        "Content-Length",
        stat.size + Buffer.byteLength(preamble)
      );

      writeHeader();

      res.end();
    } else {
      writeHeader();

      const rs = fs.createReadStream(filename);

      rs.on("open", () => {
        rs.pipe(res);
      });

      await new Promise((resolve, reject) => {
        res.on("error", (err) => {
          reject(err);
        });

        res.on("close", () => {
          reject(new Error("unecpected close"));
        });

        rs.on("error", (err) => {
          reject(err);
        });

        rs.on("end", () => {
          resolve();
        });
      });
    }
  } catch (err) {
    if (closed) {
      console.log("Connection closed prematurely");
    } else if (err.message === "area too big") {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "text/plain" });
      }

      res.end(isHead ? "" : "Area is too big.");
    } else if (err.message === "no data") {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "text/plain" });
      }

      res.end(isHead ? "" : "No elevation data for the area.");
    } else {
      console.error(err);

      if (!res.headersSent) {
        res.writeHead(500);
      }

      res.end(isHead ? "" : err.message);
    }
  } finally {
    busy = false;

    console.log("[Done]");
  }
}

server.listen(8080);

/**
 * @param {ProcessPromise} pp
 */
async function run(pp) {
  if (job.aborted) {
    pp.halt();

    throw new Error("aborted");
  }

  job.p = pp;

  let res;

  try {
    res = await pp;
  } finally {
    job.p = undefined;
  }

  if (job.aborted) {
    throw new Error("aborted");
  }

  return res;
}

async function workHard(
  threshold,
  minLen,
  simplifyTolerance,
  pixelSize,
  toOsm
) {
  const mask = JSON.parse(await fs.promises.readFile("mask.geojson", "utf8"));

  const area = turfArea(mask);

  if (!area || area > 200_000_000) {
    throw new Error("area too big");
  }

  const [w, s, e, n] = geojsonBbox(mask);

  const candidates = sources.filter(
    ({ bbox }) => bbox[0] < e && bbox[2] > w && bbox[1] < n && bbox[3] > s
  );

  // The first source with data in the mask sets the CRS and grid. Its pixels
  // are only cropped, unless pixel-size asks for another resolution.
  let primary;

  for (const src of candidates) {
    if (
      (await tryRun(
        $`gdalwarp -overwrite -of GTiff -ot Float32 -dstnodata -9999 -cutline mask.geojson -wo CUTLINE_ALL_TOUCHED=TRUE -crop_to_cutline ${
          pixelSize ? ["-tr", pixelSize, pixelSize] : []
        } ${src.path} primary.tif`
      )) &&
      (await hasData("primary.tif"))
    ) {
      primary = src;

      break;
    }
  }

  if (!primary) {
    throw new Error("no data");
  }

  const grid = await rasterInfo("primary.tif");

  const [gx, gw, , gy, , gh] = grid.geoTransform;

  const te = [
    gx,
    gy + gh * grid.size[1],
    gx + gw * grid.size[0],
    gy,
  ];

  const onGrid = ["-te", ...te, "-ts", ...grid.size];

  // The mask on the primary's grid decides which pixels are in, for every
  // source alike. The cutlines take every pixel they touch, so they keep all of
  // those; cut in each source's own grid, they would disagree along the edge.
  await run(
    $`ogr2ogr -overwrite -t_srs ${primary.wkt} mask.gpkg mask.geojson`
  );

  await fs.promises.rm("inside.tif", { force: true });

  await run(
    $`gdal_rasterize -burn 1 -init 0 -ot Byte ${onGrid} mask.gpkg inside.tif`
  );

  await run(
    $`gdal_calc.py --overwrite --hideNoData --NoDataValue=-9999 --calc ${"where(logical_and(M == 1, ~isnan(A)), A, -9999)"} -A primary.tif -M inside.tif --outfile layer0.tif`
  );

  // Lower-priority sources fill the holes left in the mask, warped onto the
  // primary's grid. Each keeps only the pixels no source before it has, so a
  // source is credited only if it adds some.
  const used = [primary];

  const layers = ["layer0.tif"];

  for (const src of candidates.slice(candidates.indexOf(primary) + 1)) {
    await run($`gdalbuildvrt -overwrite covered.vrt ${layers}`);

    await run(
      $`gdal_calc.py --overwrite --hideNoData --type=Byte --NoDataValue=0 --calc ${"logical_and(M == 1, A == -9999)"} -A covered.vrt -M inside.tif --outfile holes.tif`
    );

    if (!(await hasData("holes.tif"))) {
      break;
    }

    if (
      !(await tryRun(
        $`gdalwarp -overwrite -of GTiff -ot Float32 -dstnodata -9999 -cutline mask.geojson -wo CUTLINE_ALL_TOUCHED=TRUE -t_srs ${primary.wkt} ${onGrid} -r cubic ${src.path} filler.tif`
      ))
    ) {
      continue;
    }

    const layer = `layer${layers.length}.tif`;

    await run(
      $`gdal_calc.py --overwrite --hideNoData --NoDataValue=-9999 --calc ${"where(logical_and(logical_and(M == 1, A == -9999), ~isnan(B)), B, -9999)"} -A covered.vrt -B filler.tif -M inside.tif --outfile ${layer}`
    );

    if (await hasData(layer)) {
      used.push(src);

      layers.push(layer);
    }
  }

  if (layers.length > 1) {
    await run($`gdalbuildvrt -overwrite merged.vrt ${layers}`);

    await run($`gdal_translate -of GTiff merged.vrt cropped.tif`);
  } else {
    await fs.promises.rename("layer0.tif", "cropped.tif");
  }

  // ExtractStreams counts cells; the threshold is given in m².
  const cells = Math.max(1, Math.round(parseFloat(threshold) / (gw * -gh)));

  await run(
    $`whitebox_tools --wd=. --run=FlowAccumulationFullWorkflow --dem=cropped.tif --out_dem=dem.tif --out_pntr=pointer.tif --out_accum=accum.tif`
  );

  await run(
    $`whitebox_tools --wd=. --run=ExtractStreams --flow_accum=accum.tif --threshold=${cells} --output=streams.tif`
  );

  await run(
    $`whitebox_tools --wd=. --run=RemoveShortStreams --d8_pntr=pointer.tif --streams=streams.tif --output=long_streams.tif --min_length=${minLen}`
  );

  await run(
    $`gdal_calc.py --overwrite --calc '(A==1)*1' -A long_streams.tif --outfile long_streams_clean.tif`
  );

  const streamStats = await bandStats("long_streams_clean.tif");

  // RasterStreamsToVector panics on a raster without a single stream cell
  if (Number(streamStats?.STATISTICS_MAXIMUM) > 0) {
    await run(
      $`whitebox_tools --wd=. --run=RasterStreamsToVector --streams=long_streams_clean.tif --d8_pntr=pointer.tif --output=streams.shp`
    );

    await run($`ogr2ogr -a_srs ${primary.wkt} streams8.shp streams.shp`);

    await run($`grass --tmp-location cropped.tif --exec sh grass_batch_job.sh`);

    await run(
      $`ogr2ogr -simplify ${simplifyTolerance} -t_srs EPSG:4326 simplified.geojson smooth.gpkg`
    );
  } else {
    await fs.promises.writeFile(
      "simplified.geojson",
      JSON.stringify({ type: "FeatureCollection", features: [] })
    );
  }

  const attribution = used.flatMap((src) => src.attributions);

  // Only sources with an `osmSource` in their source.json are known to be fine
  // for OSM; for the rest the mapper has to find out.
  const cleared = used.every((src) => src.osmSource);

  const properties = cleared
    ? {
        waterway: "stream",
        source: osmValue(
          [...new Set(used.map((src) => src.osmSource))].join(";")
        ),
      }
    : {
        waterway: "stream",
        fixme:
          "Find the correct source tag for the DTM credited in x-attribution and tell freemap@freemap.sk about it.",
        "x-attribution": osmValue(
          [...new Set(attribution.map((a) => a.name))].join("; ")
        ),
      };

  await run(
    $`jq --argjson attribution ${JSON.stringify(
      attribution
    )} --argjson properties ${JSON.stringify(
      properties
    )} '. + {attribution: $attribution} | .features[].properties = $properties' simplified.geojson > result.geojson`
  );

  if (toOsm) {
    await run($`geojsontoosm result.geojson > result.osm`);

    if (!cleared) {
      // JOSM asks before uploading a layer marked so
      const osm = await fs.promises.readFile("result.osm", "utf8");

      await fs.promises.writeFile(
        "result.osm",
        osm.replace(/^<osm /, '<osm upload="false" ')
      );
    }
  }
}

/** OSM caps a tag value at 255 characters. */
function osmValue(value) {
  const chars = [...value];

  return chars.length > 255 ? chars.slice(0, 254).join("") + "…" : value;
}

/**
 * Runs a step that may fail without failing the request.
 *
 * @param {ProcessPromise} pp
 */
async function tryRun(pp) {
  const r = await run(pp.nothrow());

  if (r.exitCode !== 0) {
    console.warn(r.stderr.trim());
  }

  return r.exitCode === 0;
}

async function rasterInfo(file) {
  return JSON.parse(
    (await run($`gdalinfo -json -nomd -norat -noct ${file}`.quiet())).stdout
  );
}

/**
 * The first band's statistics. Without a valid pixel, STATISTICS_VALID_PERCENT
 * is 0 and there are no others.
 */
async function bandStats(file) {
  // without PAM, statistics left in an .aux.xml by an earlier file of the
  // same name are neither read nor written
  const r = await run(
    $`gdalinfo -json -stats --config GDAL_PAM_ENABLED NO ${file}`.quiet()
  );

  return JSON.parse(r.stdout).bands[0].metadata?.[""];
}

async function hasData(file) {
  return Number((await bandStats(file))?.STATISTICS_VALID_PERCENT) > 0;
}

function geojsonBbox(geojson) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];

  (function walk(v) {
    if (typeof v?.[0] === "number") {
      b[0] = Math.min(b[0], v[0]);
      b[1] = Math.min(b[1], v[1]);
      b[2] = Math.max(b[2], v[0]);
      b[3] = Math.max(b[3], v[1]);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      [v.features, v.geometries, v.geometry, v.coordinates].forEach(walk);
    }
  })(geojson);

  return b;
}

/**
 * Loads the elevation sources the way freemap-v3-api's elevation service does:
 * one directory per source with a `source.json` and a `source.vrt` or
 * `source.tif`, in the order the directory names sort.
 *
 * @param {string | undefined} root
 * @returns {Promise<Source[]>}
 */
async function loadSources(root) {
  if (!root) {
    return [];
  }

  /** @type {Source[]} */
  const result = [];

  for (const dir of (await fs.promises.readdir(root)).sort()) {
    const dirPath = path.join(root, dir);

    try {
      const json = await fs.promises
        .readFile(path.join(dirPath, "source.json"), "utf8")
        .catch((err) => {
          if (err.code === "ENOENT" || err.code === "ENOTDIR") {
            return undefined;
          }

          throw err;
        });

      if (json === undefined) {
        continue;
      }

      const raster = ["source.vrt", "source.tif"]
        .map((f) => path.join(dirPath, f))
        .find((f) => fs.existsSync(f));

      if (!raster) {
        throw new Error("no source.vrt or source.tif");
      }

      const info = await rasterInfo(raster);

      const wkt = info.coordinateSystem?.wkt;

      // the pipeline measures in CRS units, so it needs metres
      if (!wkt || /^(GEOGCRS|GEOGCS)\[/.test(wkt)) {
        console.warn(`Skipping ${dir}: not in a projected CRS`);

        continue;
      }

      const [width, height] = info.size;

      const { attributions = [], osmSource } = JSON.parse(json);

      result.push({
        dir,
        path: raster,
        attributions,
        osmSource: osmSource || undefined,
        wkt,
        bbox: await wgs84Bbox(info.geoTransform, width, height, wkt),
      });
    } catch (err) {
      console.warn(`Skipping ${dir}:`, err.message);
    }
  }

  console.log(`Sources: ${result.map((src) => src.dir).join(", ")}`);

  return result;
}

/**
 * The raster's footprint in WGS84, sampled on a grid: reprojected edges bow
 * past the corners.
 */
async function wgs84Bbox([gt0, gt1, gt2, gt3, gt4, gt5], width, height, wkt) {
  const steps = 64;

  const points = [];

  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const px = (i / steps) * width;

      const py = (j / steps) * height;

      points.push(
        `${gt0 + px * gt1 + py * gt2} ${gt3 + px * gt4 + py * gt5}\n`
      );
    }
  }

  const pp = $`gdaltransform -s_srs ${wkt} -t_srs EPSG:4326 -output_xy`.quiet();

  pp.stdin.end(points.join(""));

  const lonLats = (await pp).stdout
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+/).map(Number))
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));

  if (!lonLats.length) {
    throw new Error("cannot derive a WGS84 extent");
  }

  const margin = 0.01;

  return [
    Math.min(...lonLats.map(([lon]) => lon)) - margin,
    Math.min(...lonLats.map(([, lat]) => lat)) - margin,
    Math.max(...lonLats.map(([lon]) => lon)) + margin,
    Math.max(...lonLats.map(([, lat]) => lat)) + margin,
  ];
}
