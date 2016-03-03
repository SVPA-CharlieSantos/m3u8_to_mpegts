// Node modules
var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');
var fetch = require('fetch');
var Decrypter = require('./decrypter.js');
var Download = require('./download.js');

// Constants
var IV;
var keyURI;
var begunEncryption = false;
var duplicateFileCount = 0;
var mediaSequence = 0;

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
    console.log("began encryption");
    begunEncryption = true;
    keyURI = tagLine.split(',')[1];
    keyURI = keyURI.substring(5, keyURI.length - 1);
    IV = tagLine.split(',')[2];
    if (IV !== undefined && IV !== null) {
      IV = IV.substring(3);
    }
  }
}

function parseMediaPlaylist(playlist, done, rootUri, cwd) {

  var manifestLines = [],
    segments = [];

  // Split into lines
  var mediaSequence = 0;
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
          manifestLines.push(lines[i]);
          segments.push(parseResource(currentLine, lines[i], path.dirname(playlist.uri), mediaSequence));
          mediaSequence += 1;
        }
      } else if (currentLine.match(/^#EXT-X-TARGETDURATION:.+/i)) {
        playlist.targetDuration = parseInt(currentLine.split(':')[1]);
      } else if (currentLine.match(/^#EXT-X-ENDLIST/)) {
        playlist.endList = mediaSequence;
      }
    }
    cwd =  cwd + '/' + 'bandwidth-' + playlist.bandwidth + '/';
    mkdirp.sync(cwd);

    //save media playlist manifest
    fs.writeFileSync(path.resolve(cwd, 'playlist.m3u8'), manifestLines.join('\n'));
    playlist.segments = segments;
    playlist.manifestLines = manifestLines;
    playlist.download = Download;
    playlist.update = update;
    done(playlist);
  });
}


function update(rootUri) {
  //we have passed the most recently downloaded segment in our iteration
  console.log('running update');
  var passedRecent = false,
    lastSegmentUri = this.segments[this.segments.length - 1].line,
    playlist = this;
  fetch.fetchUrl(playlist.uri, function (err, meta, body) {
    var newPlaylistLines = body.toString().split('\n'),
      i,
      currentLine,
      resource;
  if (lastSegmentUri === undefined && this.segments[this.segments.length -1].endList) {
    console.log('called update, found endlist');
    return;
  }
    //iterate through manifest and check for new url
    for (i = 0; i < newPlaylistLines.length; i++) {
      currentLine = newPlaylistLines[i];
      if (currentLine.match(/^#EXT-X-KEY/i)) {
        parseEncryption(currentLine, rootUri);
      }
      else if (newPlaylistLines[i].match(/^#EXTINF/)) {
        i++;
        if (i < newPlaylistLines.length) {
          resource = parseResource(0, currentLine, newPlaylistLines[i], rootUri);
          //if we have already passed the difference in the manifest, start adding
          if (!resource.line.match(/^https?:\/\//i)) {
            resource.line = rootUri + '/' + resource.line;
          }
          if (!lastSegmentUri.match(/^https?:\/\//i)) {
            lastSegmentUri = rootUri + '/' + lastSegmentUri;
          }
          if (passedRecent) {
            playlist.segments.push(resource);
          } else if (resource.line === lastSegmentUri) {
            passedRecent = true;
         }
        }
      } else if (newPlaylistLines[i].match(/^#EXT-X-ENDLIST/)) {
        return 'end';
      }
    }
  });
}

function parseResource(tagLine, resourceLine, manifestUri, mediaSequence) {
  var resource = {
    type: 'segment',
    line: resourceLine,
    encrypted: false,
    keyURI: 'unknown',
    IV: 0,
    downloaded: false,
    mediaSequenceNumber: mediaSequence
  };
  mediaSequence += 1;
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
  } else {
    resource.IV = new Uint32Array([0,0,0,resource.mediaSequenceNumber]);
  }
  return resource;
}

module.exports = {
  parseMediaPlaylist:parseMediaPlaylist,
  parseMasterPlaylist:parseMasterPlaylist
};
