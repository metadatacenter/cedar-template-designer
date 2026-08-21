'use strict';

define([
  'angular',
  'json!config/url-service.conf.json'
], function (angular, config) {
  angular.module('cedar.templateEditor.service.frontendUrlService', [])
      .service('FrontendUrlService', FrontendUrlService);

  FrontendUrlService.$inject = ['$window'];

  function FrontendUrlService($window) {

    var workspaceBase = null;

    var service = {
      serviceId: 'FrontendUrlService'
    };

    service.init = function () {
      workspaceBase = withoutTrailingSlash(config.workspaceFrontend);
    };

    function withoutTrailingSlash(url) {
      return (url || '').replace(/\/$/, '');
    }

    function isLoopback(hostname) {
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    }

    function isSecureOrLocal(url) {
      return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
    }

    function getWorkspaceFallback(folderId) {
      var fallback = workspaceBase + '/dashboard';
      return folderId ? fallback + '?folderId=' + encodeURIComponent(folderId) : fallback;
    }

    service.getWorkspaceReturn = function (returnTo, folderId) {
      var configuredWorkspace;
      try {
        configuredWorkspace = new $window.URL(workspaceBase);
      } catch (error) {
        throw new Error('Invalid workspaceFrontend configuration');
      }
      if (!isSecureOrLocal(configuredWorkspace)) {
        throw new Error('workspaceFrontend must use HTTPS except on loopback hosts');
      }

      if (returnTo) {
        try {
          var candidate = new $window.URL(returnTo, configuredWorkspace.href);
          if (candidate.origin === configuredWorkspace.origin && isSecureOrLocal(candidate) &&
              !candidate.username && !candidate.password) {
            return candidate.href;
          }
        } catch (error) {
          // Invalid and cross-origin return URLs deliberately fall through to the safe fallback.
        }
      }
      return getWorkspaceFallback(folderId);
    };

    service.decodeRouteIdentifier = function (value) {
      if (value === null || value === undefined) {
        return value;
      }

      var decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch (error) {
        // Leave malformed route values unchanged so the backend can reject them normally.
      }

      // AngularJS wildcard routes may decode the first slash but leave the second one absent.
      return decoded.replace(/^(https?):\/([^/])/, '$1://$2');
    };

    service.getTemplateEdit = function (id) {
      return '/templates/edit/' + id;
    };

    service.getElementEdit = function (id) {
      return '/elements/edit/' + id;
    };

    service.getFieldEdit = function (id) {
      return '/fields/edit/' + id;
    };

    return service;
  }
});
