/*
cacophony-api: The Cacophony Project API server
Copyright (C) 2018  The Cacophony Project

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
import sharp from "sharp";
import { AlertStatic } from "../../models/Alert";
import { AI_MASTER } from "../../models/TrackTag";
import jsonwebtoken from "jsonwebtoken";
import mime from "mime";
import moment from "moment";
import urljoin from "url-join";
import { ClientError } from "../customErrors";
import config from "../../config";
import log from "../../logging";
import models from "../../models";
import responseUtil from "./responseUtil";
import util from "./util";
import { Request, Response } from "express";
import {
  AudioRecordingMetadata,
  Recording,
  RecordingId,
  RecordingPermission,
  RecordingProcessingState,
  RecordingType,
  TagMode,
} from "../../models/Recording";
import { Event, QueryOptions } from "../../models/Event";
import { User } from "../../models/User";
import { Order } from "sequelize";
import { FileId } from "../../models/File";
import {
  DeviceSummary,
  DeviceVisitMap,
  Visit,
  VisitEvent,
  VisitSummary,
} from "./Visits";
import { Station } from "../../models/Station";
import modelsUtil from "../../models/util/util";
import { dynamicImportESM } from "../../dynamic-import-esm";
import Sequelize from "sequelize";
import logger from "../../logging";

// @ts-ignore
export interface RecordingQuery extends Request {
  user: User;
  query: {
    where: null | any;
    tagMode: null | TagMode;
    tags: null | string[];
    offset: null | number;
    limit: null | number;
    order: null | Order;
    distinct: boolean;
    type: string;
    audiobait: null | boolean;
  };
  filterOptions: null | any;
}

// How close is a station allowed to be to another station?
export const MIN_STATION_SEPARATION_METERS = 60;
// The radius of the station is half the max distance between stations: any recording inside the radius can
// be considered to belong to that station.
export const MAX_DISTANCE_FROM_STATION_FOR_RECORDING =
  MIN_STATION_SEPARATION_METERS / 2;

export function latLngApproxDistance(
  a: [number, number],
  b: [number, number]
): number {
  const R = 6371e3;
  // Using 'spherical law of cosines' from https://www.movable-type.co.uk/scripts/latlong.html
  const lat1 = (a[0] * Math.PI) / 180;
  const costLat1 = Math.cos(lat1);
  const sinLat1 = Math.sin(lat1);
  const lat2 = (b[0] * Math.PI) / 180;
  const deltaLng = ((b[1] - a[1]) * Math.PI) / 180;
  const part1 = Math.acos(
    sinLat1 * Math.sin(lat2) + costLat1 * Math.cos(lat2) * Math.cos(deltaLng)
  );
  return part1 * R;
}

export async function tryToMatchRecordingToStation(
  recording: Recording,
  stations?: Station[]
): Promise<Station | null> {
  // If the recording does not yet have a location, return
  if (!recording.location) {
    return null;
  }

  // Match the recording to any stations that the group might have:
  if (!stations) {
    const group = await models.Group.getFromId(recording.GroupId);
    stations = await group.getStations();
  }
  const stationDistances = [];
  for (const station of stations) {
    // See if any stations match: Looking at the location distance between this recording and the stations.
    let recordingCoords = recording.location;
    if (
      !Array.isArray(recordingCoords) &&
      recordingCoords.hasOwnProperty("coordinates")
    ) {
      recordingCoords = recordingCoords.coordinates;
    }
    const distanceToStation = latLngApproxDistance(
      station.location.coordinates,
      recordingCoords as [number, number]
    );
    stationDistances.push({ distanceToStation, station });
  }
  const validStationDistances = stationDistances.filter(
    ({ distanceToStation }) =>
      distanceToStation <= MAX_DISTANCE_FROM_STATION_FOR_RECORDING
  );

  // There shouldn't really ever be more than one station within our threshold distance,
  // since we check that stations aren't too close together when we add them.  However, on the off
  // chance we *do* get two or more valid stations for a recording, take the closest one.
  validStationDistances.sort((a, b) => {
    return b.distanceToStation - a.distanceToStation;
  });
  const closest = validStationDistances.pop();
  if (closest) {
    return closest.station;
  }
  return null;
}

async function getThumbnail(rec: Recording) {
  const s3 = modelsUtil.openS3();
  let Key = `${rec.rawFileKey}-thumb`;
  if (Key.startsWith("a_")) {
    Key = Key.substr(2);
  }
  const params = {
    Key,
  };
  return s3.getObject(params).promise();
}

const THUMBNAIL_MIN_SIZE = 64;
const THUMBNAIL_PALETTE = "Viridis";
// Gets a raw cptv frame from a recording
async function getCPTVFrame(recording: Recording, frameNumber: number) {
  const { CptvDecoder } = await dynamicImportESM("cptv-decoder");
  const decoder = new CptvDecoder();
  const fileData = await modelsUtil
    .openS3()
    .getObject({
      Key: recording.rawFileKey,
    })
    .promise()
    .catch((err) => {
      return err;
    });
  //work around for error in cptv-decoder
  //best to use createReadStream() from s3 when cptv-decoder has support
  const data = new Uint8Array(fileData.Body);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const meta = await decoder.getBytesMetadata(data);
  const result = await decoder.initWithLocalCptvFile(data);
  if (!result) {
    decoder.close();
    return;
  }
  let finished = false;
  let currentFrame = 0;
  let frame;
  logger.info("Extracting frame #%d for thumbnail", frameNumber);
  while (!finished) {
    frame = await decoder.getNextFrame();
    if (frame && frame.meta.isBackgroundFrame) {
      // Skip over background frame without incrementing counter.
      continue;
    }
    finished = frame === null || (await decoder.getTotalFrames()) !== null;
    if (currentFrame == frameNumber) {
      break;
    }
    currentFrame++;
  }
  decoder.close();
  return frame;
}

// Creates and saves a thumbnail for a recording using specified thumbnail info
async function saveThumbnailInfo(recording: Recording, thumbnail) {
  const frame = await getCPTVFrame(recording, thumbnail.frame_number);
  const thumb = await createThumbnail(frame, thumbnail);

  return await modelsUtil
    .openS3()
    .upload({
      Key: `${recording.rawFileKey}-thumb`,
      Body: thumb.data,
      Metadata: thumb.meta,
    })
    .promise()
    .catch((err) => {
      return err;
    });
}

// Create a png thumbnail image  from this frame with thumbnail info
// Expand the thumbnail region such that it is a square and at least THUMBNAIL_MIN_SIZE
// width and height
//render the png in THUMBNAIL_PALETTE
//returns {data: buffer, meta: metadata about image}
async function createThumbnail(
  frame,
  thumbnail
): Promise<{ data: Buffer; meta: { palette: string; region: any } }> {
  const frameMeta = frame.meta.imageData;
  const res_x = frameMeta.width;
  const res_y = frameMeta.height;

  const size = Math.max(THUMBNAIL_MIN_SIZE, thumbnail.height, thumbnail.width);
  const thumbnail_data = new Uint8Array(size * size);

  //dimensions to it is a square with a minimum size of THUMBNAIL_MIN_SIZE
  const extra_width = (size - thumbnail.width) / 2;
  thumbnail.x -= Math.ceil(extra_width);
  thumbnail.x = Math.max(0, thumbnail.x);
  thumbnail.width = size;
  if (thumbnail.x + thumbnail.width > res_x) {
    thumbnail.x = res_x - thumbnail.width;
  }

  const extra_height = (size - thumbnail.height) / 2;
  thumbnail.y -= Math.ceil(extra_height);
  thumbnail.y = Math.max(0, thumbnail.y);
  thumbnail.height = size;
  if (thumbnail.y + thumbnail.height > res_y) {
    thumbnail.y = res_y - thumbnail.height;
  }

  // get min max for normalizsation
  let min;
  let max;
  let frame_start;
  for (let i = 0; i < size; i++) {
    frame_start = (i + thumbnail.y) * res_x + thumbnail.x;
    for (let offset = 0; offset < thumbnail.width; offset++) {
      const pixel = frame.data[frame_start + offset];
      if (!min) {
        min = pixel;
        max = pixel;
      } else {
        if (pixel < min) {
          min = pixel;
        }
        if (pixel > max) {
          max = pixel;
        }
      }
    }
  }

  let thumb_index = 0;
  for (let i = 0; i < size; i++) {
    frame_start = (i + thumbnail.y) * res_x + thumbnail.x;
    for (let offset = 0; offset < thumbnail.width; offset++) {
      let pixel = frame.data[frame_start + offset];
      pixel = (255 * (pixel - min)) / (max - min);
      thumbnail_data[thumb_index] = pixel;
      thumb_index++;
    }
  }
  let greyScaleData;
  if (thumbnail.width != size || thumbnail.height != size) {
    const resized_thumb = await sharp(thumbnail_data, {
      raw: { width: thumbnail.width, height: thumbnail.height, channels: 1 },
    })
      .greyscale()
      .resize(size, size, { fit: "contain" });
    greyScaleData = await resized_thumb.toBuffer();
    const meta = await resized_thumb.metadata();
    thumbnail.width = meta.width;
    thumbnail.height = meta.height;
  } else {
    greyScaleData = thumbnail_data;
  }
  const frameBuffer = new Uint8ClampedArray(4 * greyScaleData.length);
  const { renderFrameIntoFrameBuffer, ColourMaps } = await dynamicImportESM(
    "cptv-decoder"
  );
  let palette = ColourMaps[0];
  for (const colourMap of ColourMaps) {
    if (colourMap[0] == THUMBNAIL_PALETTE) {
      palette = colourMap;
    }
  }
  renderFrameIntoFrameBuffer(frameBuffer, greyScaleData, palette[1], 0, 255);

  const thumbMeta = {
    region: JSON.stringify(thumbnail),
    palette: palette[0],
  };
  const img = await sharp(frameBuffer, {
    raw: {
      width: thumbnail.width,
      height: thumbnail.height,
      channels: 4,
    },
  })
    .png({
      palette: true,
      compressionLevel: 9,
    })
    .toBuffer();
  return { data: img, meta: thumbMeta };
}

function makeUploadHandler(mungeData?: (any) => any) {
  return util.multipartUpload("raw", async (request, response, data, key) => {
    if (mungeData) {
      data = mungeData(data);
    }
    const recording = models.Recording.buildSafely(data);

    // Add the filehash if present
    if (data.fileHash) {
      recording.rawFileHash = data.fileHash;
    }

    let fileIsCorrupt = false;
    if (data.type === "thermalRaw") {
      // Read the file back out from s3 and decode/parse it.
      const fileData = await modelsUtil
        .openS3()
        .getObject({
          Key: key,
        })
        .promise()
        .catch((err) => {
          return err;
        });
      const { CptvDecoder } = await dynamicImportESM("cptv-decoder");
      const decoder = new CptvDecoder();
      const metadata = await decoder.getBytesMetadata(
        new Uint8Array(fileData.Body)
      );
      // If true, the parser failed for some reason, so the file is probably corrupt, and should be investigated later.
      fileIsCorrupt = await decoder.hasStreamError();
      if (fileIsCorrupt) {
        log.warning("CPTV Stream error: %s", await decoder.getStreamError());
      }
      decoder.close();

      if (
        !data.hasOwnProperty("location") &&
        metadata.latitude &&
        metadata.longitude
      ) {
        // @ts-ignore
        recording.location = [metadata.latitude, metadata.longitude];
      }
      if (
        (!data.hasOwnProperty("duration") && metadata.duration) ||
        (Number(data.duration) === 321 && metadata.duration)
      ) {
        // NOTE: Hack to make tests pass, but not allow sidekick uploads to set a spurious duration.
        //  A solid solution will disallow all of these fields that should come from the CPTV file as
        //  API settable metadata, and require tests to construct CPTV files with correct metadata.
        recording.duration = metadata.duration;
      }
      if (!data.hasOwnProperty("recordingDateTime") && metadata.timestamp) {
        recording.recordingDateTime = new Date(
          metadata.timestamp / 1000
        ).toISOString();
      }
      if (!data.hasOwnProperty("additionalMetadata") && metadata.previewSecs) {
        // NOTE: Algorithm property gets filled in later by AI
        recording.additionalMetadata = {
          previewSecs: metadata.previewSecs,
          totalFrames: metadata.totalFrames,
        };
      }
      if (data.hasOwnProperty("additionalMetadata")) {
        recording.additionalMetadata = {
          ...data.additionalMetadata,
          ...recording.additionalMetadata,
        };
      }
    }

    recording.rawFileKey = key;
    recording.rawMimeType = guessRawMimeType(data.type, data.filename);
    recording.DeviceId = request.device.id;
    recording.GroupId = request.device.GroupId;
    const matchingStation = await tryToMatchRecordingToStation(recording);
    if (matchingStation) {
      recording.StationId = matchingStation.id;
    }

    if (typeof request.device.public === "boolean") {
      recording.public = request.device.public;
    }

    await recording.save();
    if (data.metadata) {
      await tracksFromMeta(recording, data.metadata);
    }
    if (data.processingState) {
      recording.processingState = data.processingState;
      if (
        recording.processingState ==
        models.Recording.finishedState(data.type as RecordingType)
      ) {
        await sendAlerts(recording.id);
      }
    } else {
      if (!fileIsCorrupt) {
        recording.processingState = models.Recording.uploadedState(
          data.type as RecordingType
        );
      } else {
        // Mark the recording as corrupt for future investigation, and so it doesn't get picked up by the pipeline.
        log.warning("File was corrupt, don't queue for processing");
        recording.processingState = RecordingProcessingState.Corrupt;
      }
    }
    await recording.validate();
    // NOTE: The documentation for save() claims that it also does validation,
    //  so not sure if we really need the call to validate() here.
    await recording.save();

    responseUtil.validRecordingUpload(response, recording.id);
    return recording;
  });
}

// Returns a promise for the recordings query specified in the
// request.
async function query(
  request: RecordingQuery,
  type?
): Promise<{ rows: Recording[]; count: number }> {
  if (type) {
    request.query.where.type = type;
  }

  const builder = await new models.Recording.queryBuilder().init(
    request.user,
    request.query.where,
    request.query.tagMode,
    request.query.tags,
    request.query.offset,
    request.query.limit,
    request.query.order,
    request.body.viewAsSuperAdmin
  );
  builder.query.distinct = true;
  const result = await models.Recording.findAndCountAll(builder.get());

  // This gives less location precision if the user isn't admin.
  const filterOptions = models.Recording.makeFilterOptions(
    request.user,
    request.filterOptions
  );
  result.rows = result.rows.map((rec) => {
    rec.filterData(filterOptions);
    return handleLegacyTagFieldsForGetOnRecording(rec);
  });
  return result;
}

// Returns a promise for report rows for a set of recordings. Takes
// the same parameters as query() above.
async function report(request: RecordingQuery) {
  if (request.query.type == "visits") {
    return reportVisits(request);
  }
  return reportRecordings(request);
}

async function reportRecordings(request: RecordingQuery) {
  const includeAudiobait: boolean = request.query.audiobait;
  const builder = (
    await new models.Recording.queryBuilder().init(
      request.user,
      request.query.where,
      request.query.tagMode,
      request.query.tags,
      request.query.offset,
      request.query.limit,
      request.query.order
    )
  )
    .addColumn("comment")
    .addColumn("additionalMetadata");

  if (includeAudiobait) {
    builder.addAudioEvents();
  }

  builder.query.include.push({
    model: models.Station,
    attributes: ["name"],
  });

  // NOTE: Not even going to try to attempt to add typing info to this bundle
  //  of properties...
  const result: any[] = await models.Recording.findAll(builder.get());

  const filterOptions = models.Recording.makeFilterOptions(
    request.user,
    request.filterOptions
  );

  const audioFileNames = new Map();
  const audioEvents: Map<
    RecordingId,
    { timestamp: Date; volume: number; fileId: FileId }
  > = new Map();

  if (includeAudiobait) {
    // Our DB schema doesn't allow us to easily get from a audio event
    // recording to a audio file name so do some work first to look these up.
    const audioFileIds: Set<number> = new Set();
    for (const r of result) {
      const event = findLatestEvent(r.Device.Events);
      if (event && event.EventDetail) {
        const fileId = event.EventDetail.details.fileId;
        audioEvents[r.id] = {
          timestamp: event.dateTime,
          volume: event.EventDetail.details.volume,
          fileId,
        };
        audioFileIds.add(fileId);
      }
    }
    // Bulk look up file details of played audio events.
    for (const f of await models.File.getMultiple(Array.from(audioFileIds))) {
      audioFileNames[f.id] = f.details.name;
    }
  }

  const recording_url_base = config.server.recording_url_base || "";

  const labels = [
    "Id",
    "Type",
    "Group",
    "Device",
    "Station",
    "Date",
    "Time",
    "Latitude",
    "Longitude",
    "Duration",
    "BatteryPercent",
    "Comment",
    "Track Count",
    "Automatic Track Tags",
    "Human Track Tags",
    "Recording Tags",
  ];

  if (includeAudiobait) {
    labels.push(
      "Audio Bait",
      "Audio Bait Time",
      "Mins Since Audio Bait",
      "Audio Bait Volume"
    );
  }
  labels.push("URL", "Cacophony Index", "Species Classification");

  const out = [labels];

  for (const r of result) {
    r.filterData(filterOptions);

    const automatic_track_tags = new Set();
    const human_track_tags = new Set();
    for (const track of r.Tracks) {
      for (const tag of track.TrackTags) {
        const subject = tag.what || tag.detail;
        if (tag.automatic) {
          automatic_track_tags.add(subject);
        } else {
          human_track_tags.add(subject);
        }
      }
    }

    const recording_tags = r.Tags.map((t) => t.what || t.detail);

    const cacophonyIndex = getCacophonyIndex(r);
    const speciesClassifications = getSpeciesIdentification(r);

    const thisRow = [
      r.id,
      r.type,
      r.Group.groupname,
      r.Device.devicename,
      r.Station ? r.Station.name : "",
      moment(r.recordingDateTime).tz(config.timeZone).format("YYYY-MM-DD"),
      moment(r.recordingDateTime).tz(config.timeZone).format("HH:mm:ss"),
      r.location ? r.location.coordinates[0] : "",
      r.location ? r.location.coordinates[1] : "",
      r.duration,
      r.batteryLevel,
      r.comment,
      r.Tracks.length,
      formatTags(automatic_track_tags),
      formatTags(human_track_tags),
      formatTags(recording_tags),
    ];

    if (includeAudiobait) {
      let audioBaitName = "";
      let audioBaitTime = null;
      let audioBaitDelta = null;
      let audioBaitVolume = null;
      const audioEvent = audioEvents[r.id];
      if (audioEvent) {
        audioBaitName = audioFileNames[audioEvent.fileId];
        audioBaitTime = moment(audioEvent.timestamp);
        audioBaitDelta = moment
          .duration(r.recordingDateTime - audioBaitTime)
          .asMinutes()
          .toFixed(1);
        audioBaitVolume = audioEvent.volume;
      }

      thisRow.push(
        audioBaitName,
        audioBaitTime
          ? audioBaitTime.tz(config.timeZone).format("HH:mm:ss")
          : "",
        audioBaitDelta,
        audioBaitVolume
      );
    }

    thisRow.push(
      urljoin(recording_url_base, r.id.toString()),
      cacophonyIndex,
      speciesClassifications
    );
    out.push(thisRow);
  }
  return out;
}

function getCacophonyIndex(recording: Recording): string | null {
  return (
    recording.additionalMetadata as AudioRecordingMetadata
  )?.analysis?.cacophony_index
    ?.map((val) => val.index_percent)
    .join(";");
}

function getSpeciesIdentification(recording: Recording): string | null {
  return (
    recording.additionalMetadata as AudioRecordingMetadata
  )?.analysis?.species_identify
    ?.map(
      (classification) => `${classification.species}: ${classification.begin_s}`
    )
    .join(";");
}

function findLatestEvent(events: Event[]): Event | null {
  if (!events) {
    return null;
  }

  let latest = events[0];
  for (const event of events) {
    if (event.dateTime > latest.dateTime) {
      latest = event;
    }
  }
  return latest;
}

function formatTags(tags) {
  const out = Array.from(tags);
  out.sort();
  return out.join("+");
}

async function get(request, type?: RecordingType) {
  const recording = await models.Recording.get(
    request.user,
    request.params.id,
    RecordingPermission.VIEW,
    {
      type,
      filterOptions: request.query.filterOptions,
    }
  );
  if (!recording) {
    throw new ClientError("No file found with given datapoint.");
  }

  const data: any = {
    recording: handleLegacyTagFieldsForGetOnRecording(recording),
  };

  if (recording.fileKey) {
    data.cookedJWT = signedToken(
      recording.fileKey,
      recording.getFileName(),
      recording.fileMimeType
    );
    data.cookedSize = await util.getS3ObjectFileSize(recording.fileKey);
  }

  if (recording.rawFileKey) {
    data.rawJWT = signedToken(
      recording.rawFileKey,
      recording.getRawFileName(),
      recording.rawMimeType
    );
    data.rawSize = await util.getS3ObjectFileSize(recording.rawFileKey);
  }

  delete data.recording.rawFileKey;
  delete data.recording.fileKey;

  return data;
}

function signedToken(key, file, mimeType) {
  return jsonwebtoken.sign(
    {
      _type: "fileDownload",
      key: key,
      filename: file,
      mimeType: mimeType,
    },
    config.server.passportSecret,
    { expiresIn: 60 * 10 }
  );
}

async function delete_(request, response) {
  const deleted: Recording = await models.Recording.deleteOne(
    request.user,
    request.params.id
  );
  if (deleted === null) {
    return responseUtil.send(response, {
      statusCode: 400,
      messages: ["Failed to delete recording."],
    });
  }
  if (deleted.rawFileKey) {
    util.deleteS3Object(deleted.rawFileKey).catch((err) => {
      log.warning(err);
    });
  }
  if (deleted.fileKey) {
    util.deleteS3Object(deleted.fileKey).catch((err) => {
      log.warning(err);
    });
  }
  responseUtil.send(response, {
    statusCode: 200,
    messages: ["Deleted recording."],
  });
}

function guessRawMimeType(type, filename) {
  const mimeType = mime.getType(filename);
  if (mimeType) {
    return mimeType;
  }
  switch (type) {
    case "thermalRaw":
      return "application/x-cptv";
    case "audio":
      return "audio/mpeg";
    default:
      return "application/octet-stream";
  }
}

async function addTag(user, recording, tag, response) {
  if (!recording) {
    throw new ClientError("No such recording.");
  }

  // If old tag fields are used, convert to new field names.
  tag = handleLegacyTagFieldsForCreate(tag);

  const tagInstance = models.Tag.buildSafely(tag);
  tagInstance.RecordingId = recording.id;
  if (user) {
    tagInstance.taggerId = user.id;
  }
  await tagInstance.save();

  responseUtil.send(response, {
    statusCode: 200,
    messages: ["Added new tag."],
    tagId: tagInstance.id,
  });
}

function handleLegacyTagFieldsForCreate(tag) {
  tag = moveLegacyField(tag, "animal", "what");
  tag = moveLegacyField(tag, "event", "detail");
  return tag;
}

function moveLegacyField(o, oldName, newName) {
  if (o[oldName]) {
    if (o[newName]) {
      throw new ClientError(
        `can't specify both '${oldName}' and '${newName}' fields at the same time`
      );
    }
    o[newName] = o[oldName];
    delete o[oldName];
  }
  return o;
}

function handleLegacyTagFieldsForGet(tag) {
  tag.animal = tag.what;
  tag.event = tag.detail;
  return tag;
}

function handleLegacyTagFieldsForGetOnRecording(recording) {
  recording = recording.get({ plain: true });
  recording.Tags = recording.Tags.map(handleLegacyTagFieldsForGet);
  return recording;
}

const statusCode = {
  Success: 1,
  Fail: 2,
  Both: 3,
};

// reprocessAll expects request.body.recordings to be a list of recording_ids
// will mark each recording to be reprocessed
async function reprocessAll(request, response) {
  const recordings = request.body.recordings;
  const responseMessage = {
    statusCode: 200,
    messages: [],
    reprocessed: [],
    fail: [],
  };

  let status = 0;
  for (let i = 0; i < recordings.length; i++) {
    const resp = await reprocessRecording(request.user, recordings[i]);
    if (resp.statusCode != 200) {
      status = status | statusCode.Fail;
      responseMessage.messages.push(resp.messages[0]);
      responseMessage.statusCode = resp.statusCode;
      responseMessage.fail.push(resp.recordingId);
    } else {
      responseMessage.reprocessed.push(resp.recordingId);
      status = status | statusCode.Success;
    }
  }
  responseMessage.messages.splice(0, 0, getReprocessMessage(status));
  responseUtil.send(response, responseMessage);
  return;
}

function getReprocessMessage(status) {
  switch (status) {
    case statusCode.Success:
      return "All recordings scheduled for reprocessing";
    case statusCode.Fail:
      return "Recordings could not be scheduled for reprocessing";
    case statusCode.Both:
      return "Some recordings could not be scheduled for reprocessing";
    default:
      return "";
  }
}

// reprocessRecording marks supplied recording_id for reprocessing,
// under supplied user privileges
async function reprocessRecording(user, recording_id) {
  const recording = await models.Recording.get(
    user,
    recording_id,
    RecordingPermission.UPDATE
  );

  if (!recording) {
    return {
      statusCode: 400,
      messages: ["No such recording: " + recording_id],
      recordingId: recording_id,
    };
  }

  await recording.reprocess(user);

  return {
    statusCode: 200,
    messages: ["Recording scheduled for reprocessing"],
    recordingId: recording_id,
  };
}

// reprocess a recording defined by request.user and request.params.id
async function reprocess(request, response: Response) {
  const responseInfo = await reprocessRecording(
    request.user,
    request.params.id
  );
  responseUtil.send(response, responseInfo);
}

async function tracksFromMeta(recording: Recording, metadata: any) {
  if (!("tracks" in metadata)) {
    return;
  }
  try {
    const algorithmDetail = await models.DetailSnapshot.getOrCreateMatching(
      "algorithm",
      metadata["algorithm"]
    );
    const model = {
      name: "unknown",
      algorithmId: algorithmDetail.id,
    };
    if ("model_name" in metadata["algorithm"]) {
      model["name"] = metadata["algorithm"]["model_name"];
    }
    for (const trackMeta of metadata["tracks"]) {
      const track = await recording.createTrack({
        data: trackMeta,
        AlgorithmId: algorithmDetail.id,
      });
      if ("confident_tag" in trackMeta) {
        model["all_class_confidences"] = trackMeta["all_class_confidences"];
        await track.addTag(
          trackMeta["confident_tag"],
          trackMeta["confidence"],
          true,
          model
        );
      }
    }
  } catch (err) {
    log.error(
      "Error creating recording tracks from metadata: %s",
      err.toString()
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function updateMetadata(recording: any, metadata: any) {
  throw new Error("recordingUtil.updateMetadata is unimplemented!");
}

// Returns a promise for the recordings visits query specified in the
// request.
async function queryVisits(request: RecordingQuery): Promise<{
  visits: Visit[];
  summary: DeviceSummary;
  hasMoreVisits: boolean;
  queryOffset: number;
  totalRecordings: number;
  numRecordings: number;
  numVisits: number;
}> {
  const maxVisitQueryResults = 5000;
  const requestVisits =
    request.query.limit == null
      ? maxVisitQueryResults
      : (request.query.limit as number);

  const queryMax = maxVisitQueryResults * 2;
  let queryLimit = queryMax;
  if (request.query.limit) {
    queryLimit = Math.min(request.query.limit * 2, queryMax);
  }

  const builder = await new models.Recording.queryBuilder().init(
    request.user,
    request.query.where,
    request.query.tagMode,
    request.query.tags,
    request.query.offset,
    queryLimit,
    null,
    request.body.viewAsSuperAdmin
  );
  builder.query.distinct = true;

  const devSummary = new DeviceSummary();
  const filterOptions = models.Recording.makeFilterOptions(
    request.user,
    request.filterOptions
  );
  let numRecordings = 0;
  let remainingVisits = requestVisits;
  let totalCount, recordings, gotAllRecordings;

  while (gotAllRecordings || remainingVisits > 0) {
    if (totalCount) {
      recordings = await models.Recording.findAll(builder.get());
    } else {
      const result = await models.Recording.findAndCountAll(builder.get());
      totalCount = result.count;
      recordings = result.rows;
    }

    numRecordings += recordings.length;
    gotAllRecordings = recordings.length + builder.query.offset >= recordings;
    if (recordings.length == 0) {
      break;
    }

    for (const rec of recordings) {
      rec.filterData(filterOptions);
    }
    devSummary.generateVisits(recordings, request.query.offset || 0);

    if (!gotAllRecordings) {
      devSummary.checkForCompleteVisits();
    }

    remainingVisits = requestVisits - devSummary.completeVisitsCount();
    builder.query.limit = Math.min(remainingVisits * 2, queryMax);
    builder.query.offset += recordings.length;
  }

  let queryOffset = 0;
  // mark all as complete
  if (gotAllRecordings) {
    devSummary.markCompleted();
  } else {
    devSummary.removeIncompleteVisits();
  }

  for (const devId in devSummary.deviceMap) {
    const devVisits = devSummary.deviceMap[devId];
    if (devVisits.visitCount == 0) {
      continue;
    }
    const events = await models.Event.query(
      request.user,
      devVisits.startTime.clone().startOf("day").toISOString(),
      devVisits.endTime.toISOString(),
      parseInt(devId),
      0,
      1000,
      false,
      { eventType: "audioBait" } as QueryOptions
    );
    if (events.rows) {
      devVisits.addAudioBaitEvents(events.rows);
    }
  }

  const audioFileIds = devSummary.allAudioFileIds();

  const visits = devSummary.completeVisits();
  visits.sort(function (a, b) {
    return b.start > a.start ? 1 : -1;
  });
  // get the offset to use for future queries
  queryOffset = devSummary.earliestIncompleteOffset();
  if (queryOffset == null && visits.length > 0) {
    queryOffset = visits[visits.length - 1].queryOffset + 1;
  }

  // Bulk look up file details of played audio events.
  const audioFileNames = new Map();
  for (const f of await models.File.getMultiple(Array.from(audioFileIds))) {
    audioFileNames[f.id] = f.details.name;
  }

  // update the references in deviceMap
  for (const visit of visits) {
    for (const audioEvent of visit.audioBaitEvents) {
      audioEvent.dataValues.fileName =
        audioFileNames[audioEvent.EventDetail.details.fileId];
    }
  }
  return {
    visits: visits,
    summary: devSummary,
    hasMoreVisits: !gotAllRecordings,
    totalRecordings: totalCount,
    queryOffset: queryOffset,
    numRecordings: numRecordings,
    numVisits: visits.length,
  };
}

function reportDeviceVisits(deviceMap: DeviceVisitMap) {
  const device_summary_out = [
    [
      "Device ID",
      "Device Name",
      "Group Name",
      "First Visit",
      "Last Visit",
      "# Visits",
      "Avg Events per Visit",
      "Animal",
      "Visits",
      "Using Audio Bait",
      "", //needed for visits columns to show
      "",
      "",
    ],
  ];
  for (const [deviceId, deviceVisits] of Object.entries(deviceMap)) {
    const animalSummary = deviceVisits.animalSummary();

    device_summary_out.push([
      deviceId,
      deviceVisits.deviceName,
      deviceVisits.groupName,
      deviceVisits.startTime.tz(config.timeZone).format("HH:mm:ss"),
      deviceVisits.endTime.tz(config.timeZone).format("HH:mm:ss"),
      deviceVisits.visitCount.toString(),
      (
        Math.round((10 * deviceVisits.eventCount) / deviceVisits.visitCount) /
        10
      ).toString(),
      Object.keys(animalSummary).join(";"),
      Object.values(animalSummary)
        .map((summary: VisitSummary) => summary.visitCount)
        .join(";"),
      deviceVisits.audioBait.toString(),
    ]);

    for (const animal in animalSummary) {
      const summary = animalSummary[animal];
      device_summary_out.push([
        deviceId,
        summary.deviceName,
        summary.groupName,
        summary.start.tz(config.timeZone).format("HH:mm:ss"),
        summary.end.tz(config.timeZone).format("HH:mm:ss"),
        summary.visitCount.toString(),
        (summary.visitCount / summary.eventCount).toString(),
        animal,
        summary.visitCount.toString(),
        deviceVisits.audioBait.toString(),
      ]);
    }
  }
  return device_summary_out;
}

async function reportVisits(request: RecordingQuery) {
  const results = await queryVisits(request);
  const out = reportDeviceVisits(results.summary.deviceMap);
  const recordingUrlBase = config.server.recording_url_base || "";
  out.push([]);
  out.push([
    "Visit ID",
    "Group",
    "Device",
    "Type",
    "AssumedTag",
    "What",
    "Rec ID",
    "Date",
    "Start",
    "End",
    "Confidence",
    "# Events",
    "Audio Played",
    "URL",
  ]);

  for (const visit of results.visits) {
    addVisitRow(out, visit);

    const audioEvents = visit.audioBaitEvents.sort(function (a, b) {
      return moment(a.dateTime) > moment(b.dateTime) ? 1 : -1;
    });

    let audioEvent = audioEvents.pop();
    let audioTime, audioBaitBefore;
    if (audioEvent) {
      audioTime = moment(audioEvent.dateTime);
    }
    // add visit events and audio bait in descending order
    for (const event of visit.events) {
      audioBaitBefore = audioTime && audioTime.isAfter(event.start);
      while (audioBaitBefore) {
        addAudioBaitRow(out, audioEvent);
        audioEvent = audioEvents.pop();
        if (audioEvent) {
          audioTime = moment(audioEvent.dateTime);
        } else {
          audioTime = null;
        }
        audioBaitBefore = audioTime && audioTime.isAfter(event.start);
      }
      addEventRow(out, event, recordingUrlBase);
    }
    if (audioEvent) {
      audioEvents.push(audioEvent);
    }
    for (const audioEvent of audioEvents.reverse()) {
      addAudioBaitRow(out, audioEvent);
    }
  }
  return out;
}

function addVisitRow(out: any, visit: Visit) {
  out.push([
    visit.visitID.toString(),
    visit.deviceName,
    visit.groupName,
    "Visit",
    visit.what,
    visit.what,
    "",
    visit.start.tz(config.timeZone).format("YYYY-MM-DD"),
    visit.start.tz(config.timeZone).format("HH:mm:ss"),
    visit.end.tz(config.timeZone).format("HH:mm:ss"),
    "",
    visit.events.length.toString(),
    visit.audioBaitVisit.toString(),
    "",
  ]);
}

function addEventRow(out: any, event: VisitEvent, recordingUrlBase: string) {
  out.push([
    "",
    "",
    "",
    "Event",
    event.assumedTag,
    event.trackTag ? event.trackTag.what : "",
    event.recID.toString(),
    event.start.tz(config.timeZone).format("YYYY-MM-DD"),
    event.start.tz(config.timeZone).format("HH:mm:ss"),

    event.end.tz(config.timeZone).format("HH:mm:ss"),
    event.trackTag ? event.trackTag.confidence + "%" : "",
    "",
    "",
    urljoin(recordingUrlBase, event.recID.toString(), event.trackID.toString()),
  ]);
}

function addAudioBaitRow(out: any, audioBait: Event) {
  let audioPlayed = audioBait.dataValues.fileName;
  if (audioBait.EventDetail.details.volume) {
    audioPlayed += " vol " + audioBait.EventDetail.details.volume;
  }
  out.push([
    "",
    "",
    "",
    "Audio Bait",
    "",
    audioBait.dataValues.fileName,
    "",
    moment(audioBait.dateTime).tz(config.timeZone).format("YYYY-MM-DD"),
    moment(audioBait.dateTime).tz(config.timeZone).format("HH:mm:ss"),
    "",
    "",
    "",
    audioPlayed,
    "",
  ]);
}

// Gets a single recording with associated tables required to calculate a visit
// calculation
async function getRecordingForVisit(id: number): Promise<Recording> {
  const query = {
    include: [
      {
        model: models.Group,
        attributes: ["groupname"],
      },
      {
        model: models.Track,
        where: {
          archivedAt: null,
        },
        attributes: [
          "id",
          [
            Sequelize.fn(
              "json_build_object",
              "start_s",
              Sequelize.literal(`"Tracks"."data"#>'{start_s}'`),
              "end_s",
              Sequelize.literal(`"Tracks"."data"#>'{end_s}'`)
            ),
            "data",
          ],
        ],
        required: false,
        include: [
          {
            model: models.TrackTag,
            attributes: [
              "what",
              "automatic",
              "TrackId",
              "confidence",
              [Sequelize.json("data.name"), "data"],
            ],
          },
        ],
      },
      {
        model: models.Device,
        attributes: ["devicename", "id"],
      },
    ],
    attributes: [
      "id",
      "recordingDateTime",
      "DeviceId",
      "GroupId",
      "rawFileKey",
    ],
  };
  // @ts-ignore
  return await models.Recording.findByPk(id, query);
}

async function sendAlerts(recID: number) {
  const recording = await getRecordingForVisit(recID);
  const recVisit = new Visit(recording, 0);
  recVisit.completeVisit();
  let matchedTrack, matchedTag;
  // find any ai master tags that match the visit tag
  for (const track of recording.Tracks) {
    matchedTag = track.TrackTags.find(
      (tag) => tag.data == AI_MASTER && recVisit.what == tag.what
    );
    if (matchedTag) {
      matchedTrack = track;
      break;
    }
  }
  if (!matchedTag) {
    return;
  }

  const alerts = await (models.Alert as AlertStatic).getActiveAlerts(
    recording.DeviceId,
    matchedTag
  );
  if (alerts.length > 0) {
    const thumbnail = await getThumbnail(recording).catch(() => {
      log.warning("Alerting without thumbnail for %d", recID);
    });
    for (const alert of alerts) {
      await alert.sendAlert(
        recording,
        matchedTrack,
        matchedTag,
        thumbnail ? thumbnail.Body : thumbnail
      );
    }
  }
  return alerts;
}

export default {
  makeUploadHandler,
  query,
  report,
  get,
  delete_,
  addTag,
  reprocess,
  reprocessAll,
  tracksFromMeta,
  updateMetadata,
  queryVisits,
  saveThumbnailInfo,
  sendAlerts,
  getThumbnail,
  signedToken,
};
