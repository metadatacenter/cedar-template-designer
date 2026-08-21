'use strict';

define([
  'angular',
  'json!config/url-service.conf.json'
], function (angular, config) {
  angular.module('cedar.templateEditor.service.frontendUrlService', [])
      .service('FrontendUrlService', FrontendUrlService);

  FrontendUrlService.$inject = ['$window'];

  function FrontendUrlService($window) {

    let openViewBase = null;
    let embeddableEditorBase = null;
    let workspaceBase = null;
    let dataciteDOIBase = null
    let downloadBase = null
    let monitoringBase = null

    let service = {
      serviceId: "FrontendUrlService"
    };

    service.init = function () {
      openViewBase = config.openViewBase;
      embeddableEditorBase = withoutTrailingSlash(config.artifactsFrontend);
      workspaceBase = withoutTrailingSlash(config.workspaceFrontend);
      dataciteDOIBase = config.dataciteDOIBase;
      downloadBase = config.downloadBase;
      monitoringBase = config.monitoringFrontend;
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

    service.getTemplateEdit = function (id) {
      return "/templates/edit/" + id;
    };

    service.getElementEdit = function (id) {
      return "/elements/edit/" + id;
    };

    service.getFieldEdit = function (id) {
      return "/fields/edit/" + id;
    };

    service.getInstanceCreate = function (id, folderId) {
      return '/instances/create/' + id + '?folderId=' + encodeURIComponent(folderId);
    };

    service.getInstanceEdit = function (id) {
      return "/instances/edit/" + id;
    };

    service.getFolderContents = function (folderId) {
      return '/dashboard?folderId=' + encodeURIComponent(folderId);
    };

    service.getMyWorkspace = function () {
      return '/dashboard';
    };

    service.getSearchAll = function (folderId) {
      return '/dashboard?search=*&folderId=' + folderId;
    };

    service.getSharedWithMe = function (folderId) {
      return '/dashboard?sharing=shared-with-me&folderId=' + folderId;
    };

    service.getSpecialFolders = function (folderId) {
      return '/dashboard?viewMode=view-special-folders&folderId=' + folderId;
    };

    service.getSharedWithEverybody = function (folderId) {
      return '/dashboard?sharing=shared-with-everybody&folderId=' + folderId;
    };

    service.getMessaging = function (folderId) {
      return '/messaging?folderId=' + encodeURIComponent(folderId);
    };

    service.openField = function (id) {
      return openViewBase + '/template-fields/' + encodeURIComponent(id);
    };

    service.openElement = function (id) {
      return openViewBase + '/template-elements/' + encodeURIComponent(id);
    };

    service.openTemplate = function (id) {
      return openViewBase + '/templates/' + encodeURIComponent(id);
    };

    service.openInstance = function (id) {
      return openViewBase + '/template-instances/' + encodeURIComponent(id);
    };

    service.openFolder = function (id) {
      return openViewBase + '/folders/' + encodeURIComponent(id);
    };

    service.ceeCreateInstance = function (id, folderId) {
      return embeddableEditorBase + '/instances/create/' + encodeURIComponent(id) + '?folderId=' + encodeURIComponent(folderId);
    };

    service.eeEditInstance = function (id) {
      return embeddableEditorBase + '/instances/edit/' + encodeURIComponent(id);
    };

    service.dataciteTemplate = function (id) {
      return dataciteDOIBase + '/' + encodeURIComponent(id);
    };

    service.dataciteInstance = function (id) {
      return dataciteDOIBase + '/' + encodeURIComponent(id);
    };

    service.downloadResource = function (id) {
      return downloadBase + '/' + encodeURIComponent(id);
    };

    // The CEDAR monitoring dashboard: a separate CEDAR frontend on the same Keycloak realm,
    // so it opens in a new tab but the user stays signed in.
    service.getMonitoring = function () {
      return monitoringBase;
    };

    return service;
  }

});
