import http from "node:http";
import fs from "node:fs";
import process from "node:process";
import { $ } from "zx";

/** @type {import("zx").ProcessPromise} */
let p;

let busy = false;

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

  res.on("close", () => {
    console.log("[Closed]");

    closed = true;

    p?.kill("SIGTERM").catch((err) =>
      console.error("Error terminating process", err)
    );

    p = undefined;
  });

  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;

  const threshold = params.get("threshold") || "20000";

  const pixelSize = params.get("pixel-size");

  const minLen = params.get("min-len") || "50";

  const simplifyTolerance = params.get("simplify-tolerance") || "1.5";

  const toOsm = !!params.get("to-osm");

  busy = true;

  function writeHeader() {
    if (res.headersSent) {
      return;
    }

    res.writeHead(200, {
      "Content-Type": toOsm ? "application/xml" : "application/geo+json",
      // "Content-Disposition": 'attachment; filename="streams.geojson"',
    });
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
    } else if (req.method === "GET") {
      const mask = params.get("mask");

      if (!mask) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing mask parameter.");
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

    const tid = setInterval(() => {
      writeHeader();

      res.write("\n");
    }, 10000);

    try {
      await workHard(threshold, minLen, simplifyTolerance, pixelSize, toOsm);
    } finally {
      clearInterval(tid);
    }

    writeHeader();

    const rs = fs.createReadStream(toOsm ? "result.osm" : "result.geojson");

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
  } catch (err) {
    if (closed) {
      console.log("Connection closed prematurely");
    } else if (err.message === "area too big") {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "text/plain" });
      }
      res.end("Area is too big.");
    } else {
      console.error(err);

      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end(err.message);
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
  p = pp;

  const res = await pp;

  p = undefined;

  return res;
}

async function workHard(
  threshold,
  minLen,
  simplifyTolerance,
  pixelSize,
  toOsm
) {
  const a = await run(
    $`ogrinfo -q -dialect SQLite -sql "SELECT SUM(ST_Area(st_transform(geometry, 8353))) AS area FROM mask" mask.geojson`
  );

  const area = Number(/area \(Real\) = ([\d\.]*)/.exec(a.stdout)?.[1]);

  if (!area || area > 200_000_000) {
    throw new Error("area too big");
  }

  const demPath =
    process.env.DEM_PATH ??
    "/media/martin/OSM/___LIDAR_UGKK_DEM5_0_JTSK03_1cm.tif";

  await run(
    $`gdalwarp -overwrite -of GTiff -dstnodata -9999 -cutline mask.geojson -crop_to_cutline ${
      pixelSize ? `-tr ${pixelSize} ${pixelSize}` : ""
    } ${demPath} cropped.tif`
  );

  await run(
    $`whitebox_tools --wd=. --run=FlowAccumulationFullWorkflow --dem=cropped.tif --out_dem=dem.tif --out_pntr=pointer.tif --out_accum=accum.tif`
  );

  await run(
    $`whitebox_tools --wd=. --run=ExtractStreams --flow_accum=accum.tif --threshold=${threshold} --output=streams.tif`
  );

  await run(
    $`whitebox_tools --wd=. --run=RemoveShortStreams --d8_pntr=pointer.tif --streams=streams.tif --output=long_streams.tif --min_length=${minLen}`
  );

  await run(
    $`gdal_calc.py --overwrite --calc '(A==1)*1' -A long_streams.tif --outfile long_streams_clean.tif`
  );

  await run(
    $`whitebox_tools --wd=. --run=RasterStreamsToVector --streams=long_streams_clean.tif --d8_pntr=pointer.tif --output=streams`
  );

  await run($`ogr2ogr -a_srs epsg:8353 streams8.shp streams.shp`);

  await run($`grass --tmp-location EPSG:8353 --exec sh grass_batch_job.sh`);

  await run(
    $`ogr2ogr -simplify ${simplifyTolerance} -t_srs EPSG:4326 simplified.geojson smooth.gpkg`
  );

  await run(
    $`jq '.features[].properties = {waterway: "stream", source: "ÚGKK SR DMR 5.0"}' simplified.geojson > result.geojson`
  );

  if (toOsm) {
    await run($`geojsontoosm result.geojson > result.osm`);
  }
}
