import http from "node:http";
import fs from "node:fs";
import { $, ProcessPromise } from "zx";

/** @type {ProcessPromise} */
let p;

let busy = false;

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Only POST method is allowed.");
    return;
  }

  if (req.headers["content-type"] !== "application/json") {
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

    console.log("[Responding]");

    let headerWritten = false;

    function writeHeader() {
      if (headerWritten) {
        return;
      }

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="streams.geojson"',
      });

      headerWritten = true;
    }

    const tid = setInterval(() => {
      res.write("\n");
    }, 10000);

    try {
      await process();
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
  } catch (e) {
    if (closed) {
      console.log("Connection closed prematurely");
    } else {
      res.writeHead(500);
      res.end(e.message);
    }
  } finally {
    busy = false;

    console.log("[Done]");
  }
});

server.listen(8080);

/**
 * @param {ProcessPromise} pp
 */
async function run(pp) {
  p = pp;

  await pp;

  p = undefined;
}

async function process() {
  await run(
    $`gdalwarp -overwrite -of GTiff -cutline mask.geojson -crop_to_cutline /media/martin/OSM/___LIDAR_UGKK_DEM5_0_JTSK03_1cm.tif cropped.tif`
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
    $`gdal_calc.py --calc '(A==1)*1' -A long_streams.tif --outfile long_streams_clean.tif`
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
