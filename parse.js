// Node modules
var URL = require('url');
var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');
var fetch = require('fetch');
var Decrypter = require('./decrypter.js');

// Constants
var IV;
var keyURI;
var begunEncryption = false;
var duplicateFileCount = 0;

function parseMasterPlaylist (manifestUri, manifestData) {
  var manifestLines = [],
    mediaPlaylists = [],
    rootUri = path.dirname(manifestUri),
    lines,
    currentLine,
    i,
    mediaPlaylist;

  // Split into lines
  lines = manifestData.split('\n');
  for (i = 0; i < lines.length; i++) {
    currentLine = lines[i];
    manifestLines.push(currentLine);
    if (currentLine.match(/^#EXT-X-STREAM-INF/i)) {
      i++;
      manifestLines.push(lines[i]);
      // we found a media playlist
      mediaPlaylist = {
        targetDuration:0,
        uri:lines[i],
        mostRecentSegmentUri:undefined,
        bandwidth:parseInt(currentLine.match(/BANDWIDTH=\d+/i)[0].split('=')[1]),
        segments: []
      }

      //make our url absolute if we have to
      if (!mediaPlaylist.uri.match(/^https?:\/\//i)) {
        mediaPlaylist.uri = path.dirname(manifestUri) + '/' + mediaPlaylist.uri;
      }
      mediaPlaylists.push(mediaPlaylist);
    }
  }
  return {
    manLines:manifestLines,
    medPlaylists: mediaPlaylists
  };
}

function parseEncryption(tagLine, manifestUri) {
  if (tagLine.match(/^#EXT-X-KEY/i) && tagLine.match(/AES/)) {
    begunEncryption = true;
    keyURI = tagLine.split(',')[1];
    keyURI = keyURI.substring(5, keyURI.length - 1);
    IV = tagLine.split(',')[2]
    IV = IV.substring(3, IV.length - 1);
  }
}

function parseMediaPlaylist(playlist, done, rootUri) {
  var manifestLines = [],
    segments = [];

  // Split into lines
  fetch.fetchUrl(playlist.uri, function (err, meta, body) {
    var lines = body.toString().split('\n'),
    i,
    currentLine;

    // determine resources, and store all lines
    for (i = 0; i < lines.length; i++) {
      currentLine = lines[i];
      manifestLines.push(currentLine);
      if (currentLine.match(/^#EXT-X-KEY/i)) {
        parseEncryption(currentLine, rootUri);
      } else if (currentLine.match(/^#EXTINF/)) {
        i++;
        if (i < lines.length) {
          segments.push(parseResource(currentLine, lines[i], path.dirname(playlist.uri)));
        }
      } else if (currentLine.match(/^#EXT-X-TARGETDURATION:.+/i)) {
        playlist.targetDuration = parseInt(currentLine.split(':')[1]);
      }
    }
    playlist.segments = segments;
    playlist.manifestLines = manifestLines;
    playlist.download = download;
    playlist.update = update;
    done(playlist);
  });
}

//downloads the first segment encountered that hasn't already been downloaded.
function download(rootUri, cwd) {
  var i,
    seg,
    filename;

  for (i = 0; i < this.segments.length; i++) {
    seg = this.segments[i];
    if (!seg.downloaded) {

      if (!seg.line.match(/^https?:\/\//i)) {
        seg.line = rootUri + '/' + seg.line;
      }
      seg.downloaded = true;
      filename = path.basename(seg.line);
      console.log('Start fetching', seg.line);
      if (seg.encrypted) {
        // Fetch the key
        fetch.fetchUrl(seg.keyURI, function (err, meta, keyBody) {
          var key_bytes;
          if (err) {
            return done(err);
          }
          // Convert it to an Uint32Array
          key_bytes = new Uint32Array([
            keyBody.readUInt32BE(0),
            keyBody.readUInt32BE(4),
            keyBody.readUInt32BE(8),
            keyBody.readUInt32BE(12)
          ]);
          // Fetch segment data

          fetch.fetchUrl(seg.line, function (err, meta, segmentBody) {
            if (err) {
              return done(err);
            }
            // Convert it to an Uint8Array
            var segmentData = new Uint8Array(segmentBody),
              decryptedSegment;

            // Use key, iv, and segment data to decrypt segment into Uint8Array
            decryptedSegment = new Decrypter(segmentData, key_bytes, seg.IV, function (err, data) {
              // Save Uint8Array to disk
              if (filename.match(/\?/)) {
                filename = filename.match(/^.+\..+\?/)[0];
                filename = filename.substring(0, filename.length - 1);
              }
              if (fs.existsSync(path.resolve(cwd, filename))) {
                filename = filename.split('.')[0] + duplicateFileCount + '.' + filename.split('.')[1];
                duplicateFileCount += 1;
              }
              return fs.writeFile(path.resolve(cwd, filename), new Buffer(data), function () { console.log("Finished fetching")});
            });
          });
        });
      } else {
        return streamToDisk(seg, filename, cwd);
      }
      return;
    }
  }
}

function streamToDisk (resource, filename, cwd) {
  // Fetch it to CWD (streaming)

  var segmentStream = new fetch.FetchStream(resource.line),
    outputStream;

  //handle duplicate filenames & remove query parameters
  if (filename.match(/\?/)) {
    filename = filename.match(/^.+\..+\?/)[0];
    filename = filename.substring(0, filename.length - 1);
  }

  if (fs.existsSync(path.resolve(cwd, filename))) {
    filename = filename.split('.')[0] + duplicateFileCount + '.' + filename.split('.')[1];
    duplicateFileCount += 1;
  }
  if (!filename.match(/.+ts$/i)) {
    filename = "segment" + duplicateFileCount + ".ts";
    duplicateFileCount += 1;
  }

  outputStream = fs.createWriteStream(path.resolve(cwd, filename));

  segmentStream.pipe(outputStream);

  segmentStream.on('error', function (err) {
    console.error('Fetching of url:', resource.line);
    //return done(err);
  });

  segmentStream.on('end', function () {
    console.log('Finished fetching', resource.line);
    //return done();
  });
}

function update(rootUri) {
  //we have passed the most recently downloaded segment in our iteration
  var passedRecent = false,
    lastSegmentUri = this.segments[this.segments.length - 1].uri,
    playlist = this;

  fetch.fetchUrl(playlist.uri, function (err, meta, body) {
    var newPlaylistLines = body.toString().split('\n'),
      i,
      currentLine,
      resource;

    //iterate through manifest and check for new url
    for (i = 0; i < newPlaylistLines.length; i++) {
      currentLine = newPlaylistLines[i];
      if (currentLine.match(/^#EXT-X-KEY/i)) {
        parseEncryption(currentLine, rootUri);
      }
      else if (newPlaylistLines[i].match(/^#EXTINF/)) {
        i++;
        if (i < newPlaylistLines.length) {
          resource = parseResource(currentLine, newPlaylistLines[i], rootUri);
          //if we have already passed the difference in the manifest, start adding
          if (passedRecent) {
            playlist.segments.push(resource);
          } else if (resource.uri === playlist.mostRecentUri) {
            passedRecent = true;
          }
        }
      }
    }
  });
}

function parseResource(tagLine, resourceLine, manifestUri) {
  var resource = {
    type: 'segment',
    line: resourceLine,
    encrypted: false,
    keyURI: 'unknown',
    IV: 0,
    downloaded: false
  };

  if (begunEncryption) {
    resource.encrypted = true;
    resource.keyURI = keyURI;
    resource.IV = IV;
    // make our uri absolute if we need to
    if (!resource.keyURI.match(/^https?:\/\//i)) {
      resource.keyURI = manifestUri + '/' + resource.keyURI;
    }
  }
  if (resource.IV) {
    if (resource.IV.substring(0,2) === '0x') {
      resource.IV = resource.IV.substring(2);
    }
    resource.IV = resource.IV.match(/.{8}/g);
    resource.IV[0] = parseInt(resource.IV[0], 16);
    resource.IV[1] = parseInt(resource.IV[1], 16);
    resource.IV[2] = parseInt(resource.IV[2], 16);
    resource.IV[3] = parseInt(resource.IV[3], 16);
    resource.IV = new Uint32Array(resource.IV);
  }
  return resource;
}

module.exports = {
  parseMediaPlaylist:parseMediaPlaylist,
  parseMasterPlaylist:parseMasterPlaylist
};
