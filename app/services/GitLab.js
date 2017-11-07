/* globals console, module, process, require */
var request = require('request');
var async = require('async');

module.exports = function () {
  'use strict';

  var self = this;

  self.cache = {
    check: false,
    jobs: [],
    projects: {},
    last_activity_at: null,
    last_check_at: null
  };

  function log () {
    if (self.config.debug) {
      var msg = [new Date().toLocaleTimeString(), '| GitLab |'];
      for (var i in arguments) {
        if (arguments.hasOwnProperty(i)) {
          msg.push(arguments[i]);
        }
      }
      console.log.apply(self, msg);
    }
  }

  function getRequestHeaders () {
    return {
      'PRIVATE-TOKEN': self.config.token
    };
  }

  function getProjectsApiUrl (page, per_page) {
    var base = self.config.url + '/',
        query = '?order_by=last_activity_at&statistics=yes&page=' + page + '&per_page=' + per_page + self.config.additional_query;
    return base + 'api/v4/projects' + query;
  }

  function getProjectJobsApiUrl (project, page, per_page) {
    var base = self.config.url + '/',
        query = '?page=' + page + '&per_page=' + per_page;
    return base + 'api/v4/projects/' + project.id + '/jobs' + query;
  }

  function getJobId (project, job) {
    return project.id + '-' + job.ref + '-' + job.stage + '-' + job.name;
  }

  //noinspection JSUnusedLocalSymbols
  function getJobNumber (project, job) {
    return project.name_with_namespace;
  }

  //noinspection JSUnusedLocalSymbols
  function getJobProject (project, job) {
    return job.ref + ' / ' + job.name;
  }

  //noinspection JSUnusedLocalSymbols
  function getJobIsRunning (project, job) {
    return (job.status === 'running' ||
            job.status === 'pending');
  }

  //noinspection JSUnusedLocalSymbols
  function getJobStartedAt (project, job) {
    return new Date(job.started_at);
  }

  //noinspection JSUnusedLocalSymbols
  function getJobFinishedAt (project, job) {
    return new Date(job.finished_at);
  }

  //noinspection JSUnusedLocalSymbols
  function getJobRequestedFor (project, job) {
    return job.commit && job.commit.author_name;
  }

  //noinspection JSUnusedLocalSymbols
  function getJobStatus (project, job) {
    switch (job.status) {
      case 'pending':
        return '#ffa500';
      case 'running':
        return 'Blue';
      case 'failed':
        return 'Red';
      case 'success':
        return 'Green';
      default:
        return 'Gray';
    }
  }

  //noinspection JSUnusedLocalSymbols
  function getJobStatusText (project, job) {
    return job.stage + ' ' + job.status;
  }

  //noinspection JSUnusedLocalSymbols
  function getJobReason (project, job) {
    return job.commit && job.commit.title;

  }

  function getJobUrl (project, job) {
    var base = self.config.url + '/';
    return base + project.path_with_namespace + '/pipelines/' + job.pipeline.id;
  }

  function getJobMonitorJob (project, job) {
    return {
      id: getJobId(project, job),
      number: getJobNumber(project, job),
      project: getJobProject(project, job),
      isRunning: getJobIsRunning(project, job),
      startedAt: getJobStartedAt(project, job),
      finishedAt: getJobFinishedAt(project, job),
      requestedFor: getJobRequestedFor(project, job),
      status: getJobStatus(project, job),
      statusText: getJobStatusText(project, job),
      reason: getJobReason(project, job),
      hasErrors: false,
      hasWarnings: false,
      url: getJobUrl(project, job)
    };
  }

  function getAllPages(getPagedApiUrl, page, pageSize, callback) {
    if (typeof page === 'function') {
      callback = page;
      page = 1;
      pageSize = 10;
    }
    if (typeof pageSize === 'function') {
      callback = pageSize;
      pageSize = 10;
    }
    log('Get', getPagedApiUrl(page, pageSize));
    request(
      {
        headers: getRequestHeaders(),
        url: getPagedApiUrl(page, pageSize),
        json: true
      },
      function (err, response, body) {
        if (!err && response.statusCode === 200) {
          var pages = parseInt(response.headers['x-total-pages'], 10);
          if (page < Math.min(pages, 5)) {
            callback(body, function () {
              process.nextTick(function () {
                getAllPages(getPagedApiUrl, page + 1, pageSize, callback);
              });
            });
          } else {
            callback(body);
          }
        } else {
          log('Error', body);
        }
      }
    );
  }

  function reduceJobs(jobs, callback) {
    var seen = {};
    var latest = null;

    var results = jobs.filter(function (job) {
      var key = job.monitor.id;
      if (typeof seen[key] === 'undefined') {
        seen[key] = job;
        return true;
      }
      else if (seen[key].monitor.startedAt < job.monitor.startedAt) {
        seen[key] = job;
        return true;
      }
      else {
        return false;
      }
    }).filter(function (job) {
      if (!latest || job.monitor.startedAt > latest) {
        latest = job.monitor.startedAt;
        return true;
      } else {
        return job.monitor.isRunning || job.status === 'failed';
      }
    });

    if (typeof callback === 'function') {
      callback(results);
    }
  }

  function getProjectJobs(project, callback) {
    getAllPages(
      function (page, per_page) {
        return getProjectJobsApiUrl(project, page, per_page);
      },
      1,
      20,
      function (results, next) {
        async.mapSeries(
          results,
          function (job, pass) {
            job.monitor = getJobMonitorJob(project, job);
            pass(null, job);
          },
          function (err, jobs) {
            reduceJobs(jobs, function (jobs) {
              if (jobs.length) {
                log('Updated ' + project.name_with_namespace + ' with ' +
                    jobs.length + ' jobs');
              }
              callback(jobs);
            });
          }
        );
      }
    );
  }

  function updateProject(project, callback) {
    if (self.config.slugs.indexOf('*/*') > -1 ||
        self.config.slugs.indexOf(project.namespace.name + "/*")  > -1 ||
        self.config.slugs.indexOf(project.path_with_namespace) > -1) {
      if (typeof project.jobs === 'undefined') {
        project.jobs = {};
      }
      if (project.jobs_enabled === true) {
        getProjectJobs(
          project,
          function (results) {
            var i, job, jobs = {};
            for (i = 0; i < results.length; i = i + 1) {
              job = results[i];
              jobs[job.monitor.id] = job;
            }
            project.jobs = jobs;
            self.cache.projects[project.id] = project;
            if (typeof callback === 'function') {
              callback(project);
            }
          }
        );
      } else {
        project.jobs = {};
        self.cache.projects[project.id] = project;
        if (typeof callback === 'function') {
          callback(project);
        }
      }
    } else {
      if (typeof callback === 'function') {
        callback(project);
      }
    }
  }

  function updateProjects(callback) {
    var last_activity_at = self.cache.last_activity_at,
        last_activity_at_after = null,
        total_projects = 0;

    // Allow only single updateProjects at time
    if (last_activity_at !== -1) {
      self.cache.last_activity_at = -1;
    } else if (last_activity_at === null) {
      last_activity_at = -1;
    } else {
      return;
    }

    // Last activity at is throttled an hour
    last_activity_at = last_activity_at - 3600 * 1000;

    getAllPages(
      getProjectsApiUrl,
      function (projects, next) {
        async.filter(
          projects,
          function (project, callback) {
            if (project.jobs_enabled === true) {
              callback(null, true);
            } else {
              callback(null, false);
            }
          },
          function (err, results) {
            async.mapSeries(
              results,
              function (project, pass) {
                var activity_at = new Date(project.last_activity_at);
                if (last_activity_at_after === null) {
                  last_activity_at_after = activity_at;
                }
                if (activity_at > last_activity_at &&
                    !(self.cache.projects[project.id] &&
                      self.cache.projects[project.id].has_running_jobs)) {
                  total_projects = total_projects + 1;
                  process.nextTick(function () {
                    updateProject(project, function (project) {
                      pass(null, project);
                    });
                  });
                } else {
                  next = null;  // fetch no more
                  pass(null, project);
                }
              },
              function (err, projects) {
                if (typeof next === 'function' &&
                    self.cache.last_activity_at === -1) {
                  next();
                } else {
                  self.cache.last_activity_at = last_activity_at_after;
                  if (typeof callback === 'function') {
                    log('Found ' + total_projects + ' new or updated projects');
                    callback(projects);
                  }
                }
              }
            );
          }
        );
      }
    );
  }

  self.check = function (callback) {
    if (self.cache.check) {
      callback(null, self.cache.jobs);
      return;
    } else {
      self.cache.check = true;
    }
    // Iterate through all known projects
    async.mapSeries(
      Object.keys(self.cache.projects),
      function (key, pass) {
        var project = self.cache.projects[key];

        // Reset flag
        project.has_running_jobs = false;

        // Iterate through all known jobs
        async.mapSeries(
          Object.keys(project.jobs),
          function (key, pass) {
            var job = project.jobs[key];

            // Trigger update for jobs without known end status
            if (job.status !== 'failed' &&
                job.status !== 'success' &&
                job.status !== 'canceled' &&
                job.status !== 'skipped') {
              project.has_running_jobs = true;
            }

            // Collect the monitor version of job
            pass(null, job.monitor);
          },
          function (err, results) {

            // Schedule updates
            if (project.has_running_jobs) {
              process.nextTick(function() {
                updateProject(project);
              });
            }

            // Pass list of job lists forward
            pass(null, results);
          }
        );
      },

      // Reduce jobs from all projects into a flat array
      function (err, jobs) {
        async.reduce(
          jobs, [],
          function (memo, item, pass) {
            pass(null, memo.concat(item));
          },
          function (err, jobs) {
            self.cache.jobs = jobs;
            self.cache.check = false;
            callback(err, jobs);
            if (self.cache.last_check_at === null ||
                self.cache.last_check_at < new Date() - self.config.interval) {
              self.cache.last_check_at = new Date();
              process.nextTick(function () {
                updateProjects();
              });
            }
          }
        );
      }
    );
  };

  /*
  "services": [{
    "name": "GitLab",
    "configuration": {
      "url": "https://gitlab.yourdomain",
      "interval": 10000,
      "slugs": [],
      "token": "secret",
      "debug": true
    }
  }]
  */
  self.configure = function (config) {
    self.config = config;
    if (typeof self.config.interval === 'undefined') {
      self.config.interval = 15000;
    }
    if (typeof self.config.slugs === 'undefined') {
      self.config.slugs = ['*/*'];
    }
    if (typeof self.config.additional_query === 'undefined') {
      self.config.additional_query = "";
    }
    if (typeof process.env.GITLAB_TOKEN !== 'undefined') {
      self.config.token = process.env.GITLAB_TOKEN;
    }
    if (typeof self.config.caPath !== 'undefined') {
      request = request.defaults({
        agentOptions: {
          ca: require('fs').readFileSync(self.config.caPath).toString().split("\n\n")
        }
      });
    }
    for (var key in self.config) {
      if (self.config.hasOwnProperty(key) && key !== 'token') {
        log(key + ':', self.config[key]);
      }
    }
  };

};
