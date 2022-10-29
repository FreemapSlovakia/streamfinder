import http from "node:http";
import fs from "node:fs";
import process from "node:process";
import { $, ProcessPromise } from "zx";
import area from "@turf/area";

/** @type {ProcessPromise} */
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

  busy = true;

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
    } else {
      const mask = new URL(
        req.url,
        `http://${req.headers.host}`
      ).searchParams.get("mask");

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
    }

    console.log("[Responding]");

    function writeHeader() {
      if (res.headersSent) {
        return;
      }

      res.writeHead(200, {
        "Content-Type": "application/json",
        // "Content-Disposition": 'attachment; filename="streams.geojson"',
      });
    }

    const tid = setInterval(() => {
      writeHeader();

      res.write("\n");
    }, 10000);

    try {
      await workHard();
    } finally {
      clearInterval(tid);
    }

    writeHeader();

    const rs = fs.createReadStream("simplified.geojson");

    rs.on("open", () => {
      rs.pipe(res);
    });

    await new Promise((resolve, reject) => {
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

async function workHard() {
  const a = await run(
    $`ogrinfo -q -dialect SQLite -sql "SELECT SUM(ST_Area(st_transform(geometry, 8353))) AS area FROM mask" mask.geojson`
  );

  const area = Number(/area \(Real\) = ([\d\.]*)/.exec(a.stdout)?.[1]);

  if (!area || area > 200_000_000) {
    throw new Error("area too big");
  }

  await run(
    $`gdalwarp -overwrite -of GTiff -cutline mask.geojson -crop_to_cutline ${
      process.env.DEM_PATH ??
      "/media/martin/OSM/___LIDAR_UGKK_DEM5_0_JTSK03_1cm.tif"
    } cropped.tif`
  );

  await run(
    $`whitebox_tools --run=FlowAccumulationFullWorkflow --dem=cropped.tif --out_dem=dem.tif --out_pntr=pointer.tif --out_accum=accum.tif`
  );

  await run(
    $`whitebox_tools --run=ExtractStreams --flow_accum=accum.tif --threshold=20000 --output=streams.tif`
  );

  await run(
    $`whitebox_tools --run=RemoveShortStreams --d8_pntr=pointer.tif --streams=streams.tif --output=long_streams.tif --min_length=50`
  );

  await run(
    $`gdal_calc.py --overwrite --calc '(A==1)*1' -A long_streams.tif --outfile long_streams_clean.tif`
  );

  await run(
    $`whitebox_tools --run=RasterStreamsToVector --streams=long_streams_clean.tif --d8_pntr=pointer.tif --output=streams`
  );

  await run($`ogr2ogr -a_srs epsg:8353 streams8.shp streams.shp`);

  await run($`grass --tmp-location EPSG:8353 --exec sh grass_batch_job.sh`);

  await run(
    $`ogr2ogr -simplify 1.5 -t_srs EPSG:4326 simplified.geojson smooth.gpkg`
  );
}
