'use strict';

define([], function () {
  describe('Keycloak bootstrap URL:', function () {
    var originalAuthUrl;

    beforeEach(function () {
      originalAuthUrl = window.cedarAuthUrl;
    });

    afterEach(function () {
      window.cedarAuthUrl = originalAuthUrl;
    });

    it('uses the generated auth origin and removes its trailing slash', function () {
      window.cedarAuthUrl = 'https://auth.metadatacenter.orgx/';

      expect(getCedarAuthUrl()).toBe('https://auth.metadatacenter.orgx');
    });
  });
});
