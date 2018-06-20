// Check topic permissions
//
// In:
//
// - params.topics - array of models.clubs.Topic. Could be plain value
// - params.user_info - user id or Object with `usergroups` array
// - params.preload - array of posts, topics or clubs (used as a cache)
// - data - cache + result
//   - user_info
//   - access_read
//   - topics
// - cache - object of `id => post, topic or club`, only used internally
//
// Out:
//
// - data.access_read - array of boolean. If `params.topics` is not array - will be plain boolean
//

'use strict';


const _        = require('lodash');
const ObjectId = require('mongoose').Types.ObjectId;
const userInfo = require('nodeca.users/lib/user_info');


module.exports = function (N, apiPath) {

  // Initialize return value for data.access_read
  //
  N.wire.before(apiPath, { priority: -100 }, function init_access_read(locals) {
    locals.data = locals.data || {};

    let topics = Array.isArray(locals.params.topics) ?
                 locals.params.topics :
                 [ locals.params.topics ];

    locals.data.topic_ids = topics.map(topic => topic._id);

    // fill in cache
    locals.cache = locals.cache || {};

    topics.forEach(topic => { locals.cache[topic._id] = topic; });

    (locals.params.preload || []).forEach(object => { locals.cache[object._id] = object; });

    // initialize access_read, remove topics that's not found in cache
    locals.data.access_read = locals.data.topic_ids.map(id => {
      if (!locals.cache[id]) return false;
      return null;
    });
  });


  // Fetch user user_info if it's not present already
  //
  N.wire.before(apiPath, async function fetch_usergroups(locals) {
    if (ObjectId.isValid(String(locals.params.user_info))) {
      locals.data.user_info = await userInfo(N, locals.params.user_info);
      return;
    }

    // Use presented
    locals.data.user_info = locals.params.user_info;
  });


  // Check clubs permission
  //
  N.wire.before(apiPath, async function check_clubs(locals) {
    let clubs = _.uniq(
      locals.data.topic_ids
          .filter((__, i) => locals.data.access_read[i] !== false)
          .map(id => String(locals.cache[id].club))
    );

    let access_env = {
      params: { clubs, user_info: locals.data.user_info },
      cache: locals.cache
    };
    await N.wire.emit('internal:clubs.access.club', access_env);

    // club_id -> access
    let clubs_access = {};

    clubs.forEach((club_id, i) => {
      clubs_access[club_id] = access_env.data.access_read[i];
    });

    locals.data.topic_ids.forEach((id, i) => {
      if (!clubs_access[locals.cache[id].club]) locals.data.access_read[i] = false;
    });
  });


  // Check topic and club permissions
  //
  N.wire.on(apiPath, async function check_topic_access(locals) {
    let Topic = N.models.clubs.Topic;
    let setting_names = [
      'can_see_hellbanned',
      'clubs_mod_can_delete_topics',
      'clubs_mod_can_see_hard_deleted_topics'
    ];

    function check(topic, i) {
      if (locals.data.access_read[i] === false) return Promise.resolve();

      if (!topic) {
        locals.data.access_read[i] = false;
        return Promise.resolve();
      }

      let params = {
        user_id: locals.data.user_info.user_id,
        usergroup_ids: locals.data.user_info.usergroups
      };

      return N.settings.get(setting_names, params, {})
        .then(settings => {

          // Topic permissions
          let topicVisibleSt = Topic.statuses.LIST_VISIBLE.slice(0);

          if (locals.data.user_info.hb || settings.can_see_hellbanned) {
            topicVisibleSt.push(Topic.statuses.HB);
          }

          if (settings.clubs_mod_can_delete_topics) {
            topicVisibleSt.push(Topic.statuses.DELETED);
          }

          if (settings.clubs_mod_can_see_hard_deleted_topics) {
            topicVisibleSt.push(Topic.statuses.DELETED_HARD);
          }

          if (topicVisibleSt.indexOf(topic.st) === -1) {
            locals.data.access_read[i] = false;
          }
        });
    }

    await Promise.all(locals.data.topic_ids.map((id, i) => check(locals.cache[id], i)));
  });


  // If no function reported error at this point, allow access
  //
  N.wire.after(apiPath, { priority: 100 }, function allow_read(locals) {
    locals.data.access_read = locals.data.access_read.map(function (val) {
      return val !== false;
    });

    // If `params.topics` is not array - `data.access_read` should be also not an array
    if (!_.isArray(locals.params.topics)) {
      locals.data.access_read = locals.data.access_read[0];
    }
  });
};
