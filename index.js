// Node modules
var path = require('path');
var fetch = require('fetch');
var parse = require('./parse.js');
var fs = require('fs');


function getIt(options, done) {
  

  var uri = options.uri,
    cwd = options.cwd,
    preferLowQuality = options.preferLowQuality | true,
    playlistFilename = path.basename(uri.split('?')[0]);

  fetch.fetchUrl(uri, function getPlaylist(err, meta, body) {
    var mediaPlaylist,
      oldLength,
      masterPlaylist,
      mediaPlaylists,
      masterManifestLines,
      i;

    if (err) {
      console.error('Error fetching url:', uri);
      return done(err);
    }

    // Check for no master playlist
    if (body.toString().match(/#EXTINF/)) {
      mediaPlaylist = {
        targetDuration:0,
        uri:options.uri,
        mostRecentSegmentUri:undefined,
        bandwidth:1000,
        segments:[]
      };
      oldLength = 1;
      parse.parseMediaPlaylist(mediaPlaylist, doneParsing, path.dirname(options.uri), cwd);
    } else {
      masterPlaylist = parse.parseMasterPlaylist(uri, body.toString());
      mediaPlaylists = masterPlaylist.medPlaylists;
      oldLength = mediaPlaylists.length;
      masterManifestLines = masterPlaylist.manLines;
      playlistFilename = playlistFilename.split('?')[0];

      //save master playlist
      fs.writeFileSync(path.resolve(cwd, playlistFilename), masterPlaylist.manLines.join('\n'));
      // parse the mediaplaylists for segments and targetDuration
      for (i = 0; i < mediaPlaylists.length; i++) {
        parse.parseMediaPlaylist(masterPlaylist.medPlaylists[i], doneParsing, path.dirname(masterPlaylist.uri), cwd);
      }
      masterPlaylist.mediaPlaylists = [];
    }

    function doneParsing(playlist) {

      if (mediaPlaylist) {
        setupDownload('media');
      } else {
        masterPlaylist.mediaPlaylists.push(playlist);
        // once we have gotten all of the data, setup downloading
        if(masterPlaylist.mediaPlaylists.length === oldLength) {

          var lowQualityIt = 0, highQualityIt = 0;  
          for (var i = 0; i < masterPlaylist.mediaPlaylists.length; i++) {    //in masterPlaylist.mediaPlaylists we got all the available playlists
            // console.log('Bandwidth: ' + masterPlaylist.mediaPlaylists[i].bandwidth);
            var curPlaylistBandwith = masterPlaylist.mediaPlaylists[i].bandwidth;         
            if(curPlaylistBandwith < masterPlaylist.mediaPlaylists[lowQualityIt].bandwidth){  //Simply finding the minimum bandwith playlist
              lowQualityIt = i;
            }
            if(curPlaylistBandwith > masterPlaylist.mediaPlaylists[highQualityIt].bandwidth){ //Simply finding the maximum bandwith playlist
              highQualityIt = i;
            }
          }
          // console.log("High quality bandwith: "+masterPlaylist.mediaPlaylists[highQualityIt].bandwidth+", low quality bandwith: "+masterPlaylist.mediaPlaylists[lowQualityIt].bandwidth);
          var sel = preferLowQuality?lowQualityIt:highQualityIt;        //If the user prefers the low quality we will download the low bandwith playlist, else the opposite
          masterPlaylist.mediaPlaylists = [masterPlaylist.mediaPlaylists[sel]]; //Setting the playlist (in this case only one playlist) to be downloaded, so that the setupDownload() method knows what to download.
          setupDownload();

        }
      }
    }
    var playlistsFinished = 0;
    function finishedDownloadingSegment(playlist) {
      playlist.download(path.dirname(playlist.uri), cwd, playlist.bandwidth, function() {
        playlistsFinished++;
        console.log('playlists finished: ', playlistsFinished);
        if (mediaPlaylist) {
          done && done();
        } else if (playlistsFinished == masterPlaylist.mediaPlaylists.length) {
          done && done();
        }
        }, finishedDownloadingSegment);


    }

    function setupDownload(type) {
      var pl,
        rootUri,
        newFunction,
        newerFunction,
        updateInterval,
        downloadInterval,
        i;

      if (type === 'media') {
        pl = [mediaPlaylist];
      } else {
        pl = masterPlaylist.mediaPlaylists;
      }

      // set update and download intervals
      for (i = 0; i < pl.length; i++) {
        if (pl[i].targetDuration === 0) {
          continue;
        }
        rootUri = path.dirname(pl[i].uri);
        updateFunction = pl[i].update.bind(pl[i]);
        downloadFunction = pl[i].download.bind(pl[i]);
        downloadFunction(rootUri, cwd, pl[i].bandwidth, function() {
          done && done();
        }, finishedDownloadingSegment);
        if (!pl[i].endList) {
          //Only set update if we haven't found an endlist
          updateInterval = setInterval(updateFunction, pl[i].targetDuration * 1000, rootUri);
        }
        //downloadInterval = setInterval(downloadFunction,pl[i].targetDuration * 1000, rootUri, cwd, pl[i].bandwidth, function() {console.log('shutting down');process.exit();});
      }
    }


  });
}

module.exports = getIt;
