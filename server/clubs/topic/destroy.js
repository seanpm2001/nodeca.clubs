// Remove topic by id
//
'use strict';


const _ = require('lodash');


module.exports = function (N, apiPath) {

  N.validate(apiPath, {
    topic_hid:    { type: 'integer', required: true },
    reason:       { type: 'string' },
    method:       { type: 'string', 'enum': [ 'hard', 'soft' ], required: true },
    as_moderator: { type: 'boolean', required: true }
  });


  // Fetch topic
  //
  N.wire.before(apiPath, async function fetch_topic(env) {
    let statuses = N.models.clubs.Topic.statuses;
    let topic = await N.models.clubs.Topic.findOne({ hid: env.params.topic_hid }).lean(true);

    if (!topic) throw N.io.NOT_FOUND;

    if (topic.st === statuses.DELETED || topic.st === statuses.DELETED_HARD) {
      throw N.io.NOT_FOUND;
    }

    env.data.topic = topic;
  });


  // Fetch first post
  //
  N.wire.before(apiPath, async function fetch_post(env) {
    let post = await N.models.clubs.Post.findOne({ _id: env.data.topic.cache.first_post }).lean(true);

    if (!post) throw N.io.NOT_FOUND;

    env.data.post = post;
  });


  // Check if user has an access to this topic
  //
  N.wire.before(apiPath, async function check_access(env) {
    let access_env = { params: { topics: env.data.topic, user_info: env.user_info } };

    await N.wire.emit('internal:clubs.access.topic', access_env);

    if (!access_env.data.access_read) throw N.io.NOT_FOUND;
  });


  // Fetch club info and membership
  //
  N.wire.before(apiPath, async function fetch_club_info(env) {
    let club = await N.models.clubs.Club.findById(env.data.topic.club)
                         .lean(true);

    if (!club) throw N.io.NOT_FOUND;

    env.data.club = club;

    let membership = await N.models.clubs.ClubMember.findOne()
                               .where('user').equals(env.user_info.user_id)
                               .where('club').equals(env.data.club._id)
                               .lean(true);

    env.data.is_club_member = !!membership;
    env.data.is_club_owner  = !!membership && membership.is_owner;
  });


  // Check permissions
  //
  N.wire.before(apiPath, async function check_permissions(env) {
    let topic = env.data.topic;

    // Check moderator permissions

    if (env.params.as_moderator) {
      let settings = await env.extras.settings.fetch([
        'clubs_mod_can_delete_topics',
        'clubs_mod_can_hard_delete_topics'
      ]);

      if (!settings.clubs_mod_can_delete_topics && !env.data.is_club_owner && env.params.method === 'soft') {
        throw N.io.FORBIDDEN;
      }

      if (!settings.clubs_mod_can_hard_delete_topics && env.params.method === 'hard') {
        throw N.io.FORBIDDEN;
      }

      return;
    }

    // Check user permissions

    // User can't hard delete topics
    if (env.params.method === 'hard') throw N.io.FORBIDDEN;

    // User can't delete topic with answers
    if (topic.cache.post_count !== 1 || topic.cache_hb.post_count !== 1) {
      throw {
        code: N.io.CLIENT_ERROR,
        message: env.t('err_delete_topic_with_answers')
      };
    }

    // Check owner of first post in topic
    if (env.user_info.user_id !== String(env.data.post.user)) {
      throw N.io.FORBIDDEN;
    }

    let clubs_edit_max_time = await env.extras.settings.fetch('clubs_edit_max_time');

    if (clubs_edit_max_time !== 0 && env.data.post.ts < Date.now() - clubs_edit_max_time * 60 * 1000) {
      throw {
        code: N.io.CLIENT_ERROR,
        message: env.t('err_perm_expired')
      };
    }
  });


  // Remove topic
  //
  N.wire.on(apiPath, async function delete_topic(env) {
    let statuses = N.models.clubs.Topic.statuses;

    let topic = env.data.topic;
    let update = {
      st: env.params.method === 'hard' ? statuses.DELETED_HARD : statuses.DELETED,
      $unset: { ste: 1 },
      prev_st: _.pick(topic, [ 'st', 'ste' ]),
      del_by: env.user_info.user_id
    };

    if (env.params.reason) {
      update.del_reason = env.params.reason;
    }

    env.res.topic = { st: update.st };

    await N.models.clubs.Topic.update({ _id: topic._id }, update);
  });


  // Remove votes
  //
  N.wire.after(apiPath, async function remove_votes(env) {
    let st = N.models.clubs.Post.statuses;

    // IDs list can be very large for big topics, but this should work
    let posts = await N.models.clubs.Post.find({ topic: env.data.topic._id, st: { $in: [ st.VISIBLE, st.HB ] } })
      .select('_id')
      .lean(true);

    await N.models.users.Vote.collection.update(
      { 'for': { $in: _.map(posts, '_id') } },
      // Just move vote `value` field to `backup` field
      { $rename: { value: 'backup' } },
      { multi: true }
    );
  });


  // TODO: schedule search index update


  // Update club counters
  //
  N.wire.after(apiPath, async function update_club(env) {
    await N.models.clubs.Club.updateCache(env.data.topic.club);
  });

  // TODO: log moderator actions
};
