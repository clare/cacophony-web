var bcrypt = require('bcrypt');

module.exports = function(sequelize, DataTypes) {
  var name = 'User';

  var attributes = {
    username: {
      type: DataTypes.STRING,
      unique: true
    },
    firstName: {
      type: DataTypes.STRING,
    },
    lastName: {
      type: DataTypes.STRING,
    },
    email: {
      type: DataTypes.STRING,
      validate: { isEmail: true },
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    superuser: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    }
  };

  const models = sequelize.models;

  const publicFields = Object.freeze([
    'id',
    'username',
  ]);

  var getAll = async function(where) {
    return await this.findAll({
      where: where,
      attributes: publicFields,
    });
  };

  const getGroupDeviceIds = async function() {
    var groupIds = await this.getGroupsIds();
    var devices = await models.Device.findAll({
      where: { GroupId: { "$in": groupIds }},
      attributes: ['id'],
    });
    return devices.map(d => d.id);
  };

  const getFromId = async function(id) {
    return await this.findById(id);
  };

  const getFromName = async function(name) {
    return await this.findOne({ where: { username: name }});
  };

  const freeUsername = async function(username) {
    var user = await this.findOne({where: {username: username }});
    if (user != null) {
      throw new Error('username in use');
    }
    return true;
  };

  var options = {
    classMethods: {
      addAssociations: addAssociations,
      apiSettableFields: apiSettableFields,
      getAll: getAll,
      getFromId: getFromId,
      getFromName: getFromName,
      freeUsername: freeUsername,
    },
    instanceMethods: {
      comparePassword: comparePassword,
      getGroupsIds: getGroupsIds,
      getDeviceIds: getDeviceIds,
      getGroupDeviceIds: getGroupDeviceIds,
      getJwtDataValues: getJwtDataValues,
      getDataValues: getDataValues,
      getAll: getAll,
    },
    hooks: {
      afterValidate: afterValidate
    }
  };
  // Define table
  return sequelize.define(name, attributes, options);
};

var apiSettableFields = [
  'firstName',
  'lastName'
];

function getJwtDataValues() {
  return {
    id: this.getDataValue('id'),
    _type: 'user'
  };
}

function getDataValues() {
  var user = this;
  return new Promise(function(resolve, reject) {
    user.getGroups()
      .then(function(groups) {
        resolve({
          id: user.getDataValue('id'),
          username: user.getDataValue('username'),
          firstName: user.getDataValue('firstName'),
          lastName: user.getDataValue('lastName'),
          email: user.getDataValue('email'),
          groups: groups
        });
      });
  });
}

function addAssociations(models) {
  models.User.belongsToMany(models.Group, { through: models.GroupUsers });
  models.User.belongsToMany(models.Device, { through: models.DeviceUsers });
}

// Returns the groups that are associated with this user (via
// GroupUsers).
function getGroupsIds() {
  return this.getGroups()
    .then(function(groups) {
      var idList = [];
      for (var key in groups) { idList.push(groups[key].id); }
      return idList;
    });
}

// Returns the devices that are directly associated with this user
// (via DeviceUsers).
function getDeviceIds() {
  return this.getDevices()
    .then(function(devices) {
      var idList = [];
      for (var key in devices) { idList.push(devices[key].id); }
      return idList;
    });
}

function afterValidate(user) {
  // TODO see if thsi can be done elsewhere, or when just validating the password.
  return new Promise(function(resolve, reject) {
    bcrypt.hash(user.password, 10, function(err, hash) {
      if (err) {
        reject(err);
      } else {
        user.password = hash;
        resolve();
      }
    });
  });
}

function comparePassword(password) {
  var user = this;
  return new Promise(function(resolve, reject) {
    bcrypt.compare(password, user.password, function(err, isMatch) {
      if (err) {
        reject(err);
      } else {
        resolve(isMatch);
      }
    });
  });
}
