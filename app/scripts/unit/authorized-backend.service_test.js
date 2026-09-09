'use strict';

define([
  'angular',
  'angularMocks',
  'cedar/template-editor/service/authorized-backend.service'
], function () {

  describe('AuthorizedBackendService artifact concurrency:', function () {
    var service;
    var $httpBackend;

    beforeEach(module('cedar.templateEditor.service.authorizedBackendService', function ($provide) {
      $provide.value('UIMessageService', {});
      $provide.value('UserService', {
        getToken: function () { return 'test-token'; }
      });
    }));

    beforeEach(inject(function (_AuthorizedBackendService_, _$httpBackend_) {
      service = _AuthorizedBackendService_;
      $httpBackend = _$httpBackend_;
    }));

    afterEach(function () {
      $httpBackend.verifyNoOutstandingExpectation();
      $httpBackend.verifyNoOutstandingRequest();
    });

    it('sends the ETag from an artifact GET on the following PUT', function () {
      var artifact;
      $httpBackend.expectGET('/templates/one?format=json').respond(200, {}, {'ETag': '"7"'});
      service.getHttpPromise({method: 'GET', url: '/templates/one?format=json'}).then(function (response) {
        artifact = response.data;
      });
      $httpBackend.flush();

      $httpBackend.expectPUT('/templates/one', {}, function (headers) {
        return headers['If-Match'] === '"7"';
      }).respond(200, {}, {'ETag': '"8"'});
      service.getHttpPromise({method: 'PUT', url: '/templates/one', data: {}, cedarArtifact: artifact});
      $httpBackend.flush();
      expect(artifact.$$cedarEtag).toBe('"8"');
    });

    it('keeps the ETag with each concurrently loaded representation', function () {
      var firstEditor;
      var secondEditor;
      $httpBackend.expectGET('/templates/shared').respond(200, {}, {'ETag': '"4"'});
      service.getHttpPromise({method: 'GET', url: '/templates/shared'}).then(function (response) {
        firstEditor = response.data;
      });
      $httpBackend.flush();
      $httpBackend.expectGET('/templates/shared').respond(200, {}, {'ETag': '"4"'});
      service.getHttpPromise({method: 'GET', url: '/templates/shared'}).then(function (response) {
        secondEditor = response.data;
      });
      $httpBackend.flush();

      $httpBackend.expectPUT('/templates/shared', {}, function (headers) {
        return headers['If-Match'] === '"4"';
      }).respond(200, {}, {'ETag': '"5"'});
      service.getHttpPromise({method: 'PUT', url: '/templates/shared', data: {}, cedarArtifact: firstEditor});
      $httpBackend.flush();

      $httpBackend.expectPUT('/templates/shared', {}, function (headers) {
        return headers['If-Match'] === '"4"';
      }).respond(412, {});
      service.getHttpPromise({method: 'PUT', url: '/templates/shared', data: {}, cedarArtifact: secondEditor})
          .catch(angular.noop);
      $httpBackend.flush();
    });

    it('does not replace an explicit If-Match supplied by a caller', function () {
      $httpBackend.expectGET('/templates/two').respond(200, {}, {'ETag': '"3"'});
      service.getHttpPromise({method: 'GET', url: '/templates/two'});
      $httpBackend.flush();

      $httpBackend.expectPUT('/templates/two', {}, function (headers) {
        return headers['If-Match'] === '"caller-version"';
      }).respond(412, {});
      service.getHttpPromise({
        method: 'PUT',
        url: '/templates/two',
        data: {},
        cedarArtifact: {$$cedarEtag: '"3"'},
        headers: {'If-Match': '"caller-version"'}
      }).catch(angular.noop);
      $httpBackend.flush();
    });

    it('applies the representation ETag to PATCH and DELETE as well as PUT', function () {
      var artifact = {$$cedarEtag: '"9"'};

      $httpBackend.expectPATCH('/templates/conditional', {}, function (headers) {
        return headers['If-Match'] === '"9"';
      }).respond(200, {}, {'ETag': '"10"'});
      service.getHttpPromise({
        method: 'PATCH', url: '/templates/conditional', data: {}, cedarArtifact: artifact
      });
      $httpBackend.flush();
      expect(artifact.$$cedarEtag).toBe('"10"');

      $httpBackend.expectDELETE('/templates/conditional', function (headers) {
        return headers['If-Match'] === '"10"';
      }).respond(204);
      service.getHttpPromise({
        method: 'DELETE', url: '/templates/conditional', cedarArtifact: artifact
      });
      $httpBackend.flush();
    });

    it('does not add If-Match to an ordinary POST merely because it has a payload', function () {
      $httpBackend.expectPOST('/templates', {}, function (headers) {
        return headers['If-Match'] == null;
      }).respond(201, {}, {'ETag': '"1"'});
      service.getHttpPromise({method: 'POST', url: '/templates', data: {}});
      $httpBackend.flush();
    });
  });
});
